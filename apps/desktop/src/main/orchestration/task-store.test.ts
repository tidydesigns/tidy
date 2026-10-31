import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { TaskStore, TaskStoreError, type TaskInput } from "./task-store";

const stores: TaskStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tidy-assignment-store-"));
  directories.push(directory);
  const store = new TaskStore(join(directory, "private"));
  stores.push(store);
  await store.initialize();
  const input = {
    projectId: randomUUID(),
    parentThreadId: randomUUID(),
    childThreadId: randomUUID(),
    requestId: randomUUID(),
    prompt: "Inspect the selected design",
    harness: "codex",
    settings: {},
    designIds: [],
    depth: 1,
  } satisfies TaskInput;
  return { directory, store, input };
}
test("UI history pages retain insertion order when earlier assignments change state", async () => {
  const { store, input } = await fixture();
  const records = [];
  for (let index = 0; index < 57; index++)
    records.push(
      await store.create({
        ...input,
        requestId: randomUUID(),
        childThreadId: randomUUID(),
        prompt: `Assignment ${index}`,
      }),
    );
  const page = await store.threadPage(input.projectId, input.parentThreadId);
  expect(page.tasks.map((task) => task.id)).toEqual(
    records
      .slice(-50)
      .reverse()
      .map((task) => task.id),
  );
  expect(page.nextCursor).not.toBeNull();
  await store.transition({ id: records[0].id, state: "running" });
  const remainder = await store.threadPage(
    input.projectId,
    input.parentThreadId,
    page.nextCursor ?? undefined,
  );
  expect(remainder.tasks.map((task) => task.id)).toEqual(
    records
      .slice(0, 7)
      .reverse()
      .map((task) => task.id),
  );
  expect(remainder.nextCursor).toBeNull();
  expect((await store.threadPage(randomUUID(), input.parentThreadId)).tasks).toEqual([]);
});
test("UI result pages bound escaped bytes and omit private prompts and permission grants", async () => {
  const { store, input } = await fixture();
  for (let index = 0; index < 25; index++) {
    const task = await store.create({
      ...input,
      requestId: randomUUID(),
      childThreadId: randomUUID(),
      prompt: "x".repeat(160) + "private-brief-tail",
      parentGrant: { harness: "codex", permissionMode: "read-only" },
    });
    await store.transition({
      id: task.id,
      state: "failed",
      error: "\u0000".repeat(16000),
      summary: "\u0000".repeat(16000),
    });
  }
  const ids = new Set<string>();
  let before: number | undefined;
  do {
    const page = await store.threadPage(input.projectId, input.parentThreadId, before);
    const text = JSON.stringify(page);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(128 * 1024);
    expect(text).not.toContain("private-brief-tail");
    expect(text).not.toContain("permissionMode");
    expect(page.tasks.length).toBeGreaterThan(0);
    for (const task of page.tasks) {
      expect(ids.has(task.id)).toBe(false);
      ids.add(task.id);
    }
    before = page.nextCursor ?? undefined;
  } while (before !== undefined);
  expect(ids.size).toBe(25);
});
test("retries create one durable assignment and reject conflicting request reuse", async () => {
  const { store, input } = await fixture();
  const records = await Promise.all(Array.from({ length: 10 }, () => store.create(input)));
  expect(new Set(records.map((record) => record.id)).size).toBe(1);
  expect(records[0].state).toBe("queued");
  const error = await store
    .create({ ...input, prompt: "Different assignment" })
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "REQUEST_CONFLICT" });
});
test("restart recovers unfinished work without replay and preserves undelivered results", async () => {
  const { directory, store, input } = await fixture();
  const queued = await store.create(input);
  const running = await store.create({
    ...input,
    requestId: randomUUID(),
    childThreadId: randomUUID(),
  });
  await store.transition({ id: running.id, state: "running" });
  const complete = await store.create({
    ...input,
    requestId: randomUUID(),
    childThreadId: randomUUID(),
  });
  await store.transition({ id: complete.id, state: "running" });
  await store.transition({
    id: complete.id,
    state: "completed",
    summary: "Verified artifact",
  });
  await store.close();
  const restarted = new TaskStore(join(directory, "private"));
  stores.push(restarted);
  await restarted.initialize();
  expect((await restarted.get(queued.id))?.state).toBe("interrupted");
  expect((await restarted.get(running.id))?.state).toBe("interrupted");
  expect((await restarted.get(complete.id))?.summary).toBe("Verified artifact");
  expect(await restarted.pendingDeliveries()).toHaveLength(3);
  await restarted.delivered(complete.id);
  expect(await restarted.pendingDeliveries()).toHaveLength(2);
  expect((await restarted.get(complete.id))?.delivered).toBe(true);
});
test("cancellation wins over late completion and terminal results cannot be overwritten", async () => {
  const { store, input } = await fixture();
  const task = await store.create(input);
  await store.transition({ id: task.id, state: "running" });
  await store.transition({ id: task.id, state: "cancel_requested" });
  const result = await store.transition({
    id: task.id,
    state: "completed",
    summary: "Late result",
  });
  expect(result.state).toBe("cancelled");
  const error = await store
    .transition({ id: task.id, state: "running" })
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "INVALID_STATE" });
  const same = await store.transition({
    id: task.id,
    state: "cancelled",
    summary: "Overwrite",
  });
  expect(same.summary).toBe("Late result");
});
test("owner reads paginate by change sequence and enforce bounds", async () => {
  const { store, input } = await fixture();
  const first = await store.create(input);
  const second = await store.create({
    ...input,
    requestId: randomUUID(),
    childThreadId: randomUUID(),
  });
  await store.create({
    ...input,
    parentThreadId: randomUUID(),
    requestId: randomUUID(),
    childThreadId: randomUUID(),
  });
  const page = await store.list({
    projectId: input.projectId,
    parentThreadId: input.parentThreadId,
    limit: 1,
  });
  expect(page.tasks.map((task) => task.id)).toEqual([first.id]);
  const next = await store.list({
    projectId: input.projectId,
    parentThreadId: input.parentThreadId,
    after: page.cursor,
  });
  expect(next.tasks.map((task) => task.id)).toEqual([second.id]);
  const filtered = await store.list({
    projectId: input.projectId,
    parentThreadId: input.parentThreadId,
    ids: [second.id],
  });
  expect(filtered.tasks.map((task) => task.id)).toEqual([second.id]);
  await expect(
    store.list({
      projectId: input.projectId,
      parentThreadId: input.parentThreadId,
      limit: 101,
    }),
  ).rejects.toThrow();
  await expect(store.create({ ...input, prompt: "a".repeat(16_001) })).rejects.toThrow();
});
test("private storage rejects symlink directories and creates private database files", async () => {
  const { directory } = await fixture();
  expect((await stat(join(directory, "private", "tasks.sqlite"))).mode & 0o777).toBe(0o600);
  const actual = join(directory, "actual");
  await mkdir(actual);
  const link = join(directory, "linked");
  await symlink(actual, link);
  const store = new TaskStore(link);
  stores.push(store);
  await expect(store.initialize()).rejects.toThrow("Invalid assignment storage directory");
});

test("admission rejects excess storage requests without losing accepted writes", async () => {
  const { store, input } = await fixture();
  const results = await Promise.allSettled(
    Array.from({ length: 100 }, () =>
      store.create({
        ...input,
        requestId: randomUUID(),
        childThreadId: randomUUID(),
      }),
    ),
  );
  const accepted = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  expect(accepted).toHaveLength(64);
  expect(rejected).toHaveLength(36);
  for (const result of rejected)
    if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "BUSY" });
  expect(
    (
      await store.list({
        projectId: input.projectId,
        parentThreadId: input.parentThreadId,
        limit: 100,
      })
    ).tasks,
  ).toHaveLength(64);
});

test("active assignments cannot be delivered and empty ID filters stay empty", async () => {
  const { store, input } = await fixture();
  const task = await store.create(input);
  const error = await store.delivered(task.id).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "INVALID_STATE" });
  expect(
    (
      await store.list({
        projectId: input.projectId,
        parentThreadId: input.parentThreadId,
        ids: [],
      })
    ).tasks,
  ).toEqual([]);
});

test("child lineage survives restart and one child cannot belong to two assignments", async () => {
  const { directory, store, input } = await fixture();
  const task = await store.create(input);
  expect((await store.forChild(input.projectId, input.childThreadId))?.id).toBe(task.id);
  expect(await store.forChild(randomUUID(), input.childThreadId)).toBeUndefined();
  const error = await store
    .create({ ...input, requestId: randomUUID() })
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "REQUEST_CONFLICT" });
  await store.close();
  const restarted = new TaskStore(join(directory, "private"));
  stores.push(restarted);
  const lineage = await restarted.forChild(input.projectId, input.childThreadId);
  expect(lineage?.id).toBe(task.id);
  expect(lineage?.depth).toBe(input.depth);
  expect(lineage?.state).toBe("interrupted");
});

test("canvas receipts persist pending and completed outcomes across restart with strict bounds", async () => {
  const { directory, store } = await fixture();
  const key = `canvas-${"a".repeat(64)}`;
  expect(await store.readReceipt(key)).toBeUndefined();
  await store.writeReceipt(key, { kind: "pending", fingerprint: "operation" });
  expect(await store.readReceipt(key)).toEqual({
    kind: "pending",
    fingerprint: "operation",
  });
  await store.close();
  const restarted = new TaskStore(join(directory, "private"));
  stores.push(restarted);
  expect(await restarted.readReceipt(key)).toEqual({
    kind: "pending",
    fingerprint: "operation",
  });
  await restarted.writeReceipt(key, { kind: "complete", revision: "new" });
  expect(await restarted.readReceipt(key)).toEqual({
    kind: "complete",
    revision: "new",
  });
  await restarted.writeReceipt(key, null);
  expect(await restarted.readReceipt(key)).toBeNull();
  await expect(restarted.writeReceipt("canvas-invalid", {})).rejects.toThrow();
  await expect(restarted.writeReceipt(key, "a".repeat(64 * 1024))).rejects.toThrow("size limit");
  await expect(restarted.writeReceipt(key, undefined)).rejects.toThrow();
});

test("pending delivery pages advance beyond undeliverable earlier results", async () => {
  const { store, input } = await fixture();
  for (let index = 0; index < 102; index++) {
    const task = await store.create({
      ...input,
      requestId: randomUUID(),
      childThreadId: randomUUID(),
    });
    await store.transition({ id: task.id, state: "cancelled" });
  }
  const first = await store.pendingDeliveries();
  expect(first).toHaveLength(100);
  const cursor = first.at(-1)?.sequence;
  if (cursor === undefined) throw new Error("Expected a delivery cursor.");
  const second = await store.pendingDeliveries(cursor);
  expect(second).toHaveLength(2);
  expect(second.every((task) => task.sequence > cursor)).toBe(true);
  expect(await store.pendingDeliveries(second[1].sequence)).toEqual([]);
});

test("receipt retention rejects new keys at capacity but permits completion updates", async () => {
  const { directory, store } = await fixture();
  const { Database } = await import("bun:sqlite");
  const database = new Database(join(directory, "private", "tasks.sqlite"));
  try {
    const insert = database.query("INSERT INTO operation_receipts (key, value) VALUES (?, ?)");
    database.transaction(() => {
      for (let index = 0; index < 10_000; index++)
        insert.run(`canvas-${index.toString(16).padStart(64, "0")}`, '{"kind":"pending"}');
    })();
  } finally {
    database.close();
  }
  const existing = `canvas-${"0".repeat(64)}`;
  await store.writeReceipt(existing, { kind: "complete" });
  expect(await store.readReceipt(existing)).toEqual({ kind: "complete" });
  const error = await store
    .writeReceipt(`canvas-${"f".repeat(64)}`, {})
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "CAPACITY" });
  expect(await store.readReceipt(existing)).toEqual({ kind: "complete" });
});

test("follow-up runs preserve canonical child ownership and interrupt safely across restart", async () => {
  const { directory, store, input } = await fixture();
  const initial = await store.create(input);
  await store.transition({ id: initial.id, state: "running" });
  await store.transition({ id: initial.id, state: "completed", summary: "Original result" });
  const followupInput = {
    ...input,
    kind: "followup" as const,
    requestId: randomUUID(),
    prompt: "More work",
  };
  const followup = await store.create(followupInput);
  expect((await store.create(followupInput)).id).toBe(followup.id);
  const differentOwner = await store
    .create({ ...followupInput, parentThreadId: randomUUID(), requestId: randomUUID() })
    .catch((error: unknown) => error);
  expect(differentOwner).toMatchObject({ code: "REQUEST_CONFLICT" });
  await store.close();
  const restarted = new TaskStore(join(directory, "private"));
  stores.push(restarted);
  await restarted.initialize();
  expect((await restarted.forChild(input.projectId, input.childThreadId))?.id).toBe(initial.id);
  expect((await restarted.get(initial.id))?.summary).toBe("Original result");
  expect((await restarted.get(followup.id))?.state).toBe("interrupted");
  expect((await restarted.create(followupInput)).id).toBe(followup.id);
  expect((await restarted.get(followup.id))?.state).toBe("interrupted");
});

test("private lineage and receiver grants survive restart without reparenting ordinary recipients", async () => {
  const { store, input, directory } = await fixture();
  await store.create(input);
  const recipient = randomUUID();
  await store.setReceiver(input.projectId, recipient, true);
  const grant = store.receiverGrant(input.projectId, recipient);
  await store.create({
    ...input,
    requestId: randomUUID(),
    childThreadId: recipient,
    kind: "message",
    recipientGrant: grant,
    depth: 0,
  });
  expect(store.parentThreadId(input.projectId, input.childThreadId)).toBe(input.parentThreadId);
  expect(store.parentThreadId(input.projectId, recipient)).toBeUndefined();
  expect(store.parentThreadId(randomUUID(), input.childThreadId)).toBeUndefined();
  await store.close();
  const restored = new TaskStore(join(directory, "private"));
  stores.push(restored);
  await restored.initialize();
  expect(restored.parentThreadId(input.projectId, input.childThreadId)).toBe(input.parentThreadId);
  expect(restored.parentThreadId(input.projectId, recipient)).toBeUndefined();
  expect(await restored.forChild(input.projectId, recipient)).toBeUndefined();
  expect(restored.receiverGrant(input.projectId, recipient)).toBe(grant);
  await restored.setReceiver(input.projectId, recipient, false);
  await restored.setReceiver(input.projectId, recipient, true);
  expect(restored.receiverGrant(input.projectId, recipient)).not.toBe(grant);
});

test("fresh task views include older unfinished work without moving the history cursor", async () => {
  const { store, input } = await fixture();
  const active = await store.create(input);
  await store.transition({ id: active.id, state: "running" });
  const history = [];
  for (let index = 0; index < 57; index++) {
    const task = await store.create({
      ...input,
      requestId: randomUUID(),
      childThreadId: randomUUID(),
    });
    await store.transition({ id: task.id, state: "failed" });
    history.push(task);
  }
  const page = await store.threadPage(input.projectId, input.parentThreadId);
  expect(page.tasks.find((task) => task.id === active.id)?.state).toBe("running");
  expect(page.tasks).toHaveLength(51);
  const older = await store.threadPage(
    input.projectId,
    input.parentThreadId,
    page.nextCursor ?? undefined,
  );
  expect(new Set([...page.tasks, ...older.tasks].map((task) => task.id)).size).toBe(58);
  expect(older.nextCursor).toBeNull();
  const filtered = await store.threadPage(input.projectId, input.parentThreadId, undefined, [
    history[0].id,
  ]);
  expect(filtered.tasks.map((task) => task.id)).toEqual([history[0].id]);
});

async function recover<T>(read: () => Promise<T>) {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof TaskStoreError) || error.code !== "BUSY" || Date.now() > deadline)
        throw error;
      await Bun.sleep(10);
    }
  }
}
function currentWorker(store: TaskStore) {
  const worker: unknown = Reflect.get(store, "worker");
  if (!(worker instanceof Worker)) throw new Error("Expected a real storage worker.");
  return worker;
}

test("a failed storage worker recovers on later calls without interrupting live provider work", async () => {
  const { store, input, directory } = await fixture();
  const task = await store.create(input);
  await store.transition({ id: task.id, state: "running" });
  await store.setReceiver(input.projectId, input.childThreadId, true);
  const grant = store.receiverGrant(input.projectId, input.childThreadId);
  const oldWorker = currentWorker(store);
  await oldWorker.terminate();
  expect(store.receiverGrant(input.projectId, input.childThreadId)).toBeUndefined();
  expect(await store.get(task.id).catch((error: unknown) => error)).toMatchObject({ code: "BUSY" });
  expect((await recover(() => store.get(task.id)))?.state).toBe("running");
  expect(store.receiverGrant(input.projectId, input.childThreadId)).toBe(grant);
  expect(store.parentThreadId(input.projectId, input.childThreadId)).toBe(input.parentThreadId);
  oldWorker.emit("error", new Error("Late error from replaced worker"));
  oldWorker.emit("exit", 1);
  expect((await store.get(task.id))?.state).toBe("running");
  await store.close();
  const replacement = new TaskStore(join(directory, "private"));
  stores.push(replacement);
  expect((await replacement.get(task.id))?.state).toBe("interrupted");
});

test("a lost committed mutation fails once and is reconciled by its original request ID", async () => {
  const { store, input, directory } = await fixture();
  const worker = currentWorker(store);
  worker.removeAllListeners("message");
  const mutation = store.create(input).catch((error: unknown) => error);
  const { Database } = await import("bun:sqlite");
  const database = new Database(join(directory, "private", "tasks.sqlite"));
  let taskId: string | undefined;
  try {
    const deadline = Date.now() + 3000;
    while (!taskId) {
      const row = database
        .query<{ id: string }, [string]>("SELECT id FROM tasks WHERE request_id = ?")
        .get(input.requestId);
      taskId = row?.id;
      if (Date.now() > deadline) throw new Error("The real mutation did not commit.");
      if (!taskId) await Bun.sleep(5);
    }
  } finally {
    database.close();
  }
  worker.emit("error", new Error("Lost worker response"));
  expect(await mutation).toMatchObject({ code: "STORAGE" });
  const reconciled = await recover(() =>
    store.forRequest(input.projectId, input.parentThreadId, input.requestId),
  );
  expect(reconciled?.id).toBe(taskId);
  expect(reconciled?.state).toBe("queued");
  expect((await store.create(input)).id).toBe(taskId);
  expect(
    (await store.list({ projectId: input.projectId, parentThreadId: input.parentThreadId })).tasks,
  ).toHaveLength(1);
});

test("shutdown racing initial worker startup cannot create a replacement worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidy-store-close-race-"));
  directories.push(directory);
  const store = new TaskStore(directory);
  stores.push(store);
  const opening = store.initialize().catch((error: unknown) => error);
  await store.close();
  expect(await opening).toMatchObject({ code: "CLOSED" });
  expect(await store.initialize().catch((error: unknown) => error)).toMatchObject({
    code: "CLOSED",
  });
  expect(Reflect.get(store, "worker")).toBeUndefined();
});

const oldDate = "2000-01-01T00:00:00.000Z";
async function ageTasks(directory: string, ids: string[]) {
  const { Database } = await import("bun:sqlite");
  const database = new Database(join(directory, "private", "tasks.sqlite"));
  try {
    const update = database.query(
      "UPDATE tasks SET record = json_set(record, '$.updatedAt', ?, '$.createdAt', ?) WHERE id = ?",
    );
    database.transaction(() => {
      for (const id of ids) update.run(oldDate, oldDate, id);
    })();
  } finally {
    database.close();
  }
}

test("maintenance retains immutable request and ownership grants while bounding rich history", async () => {
  const { store, input, directory } = await fixture();
  const original = {
    ...input,
    settings: { permissionMode: "read-only" as const },
    designIds: [randomUUID()],
  };
  const task = await store.create(original);
  await store.transition({ id: task.id, state: "running" });
  await store.transition({ id: task.id, state: "completed", summary: "Retained until expiry" });
  await store.delivered(task.id);
  const undelivered = await store.create({
    ...input,
    requestId: randomUUID(),
    childThreadId: randomUUID(),
  });
  await store.transition({ id: undelivered.id, state: "failed", error: "Not delivered" });
  const running = await store.create({
    ...input,
    requestId: randomUUID(),
    childThreadId: randomUUID(),
  });
  await store.transition({ id: running.id, state: "running" });
  await ageTasks(directory, [task.id, undelivered.id, running.id]);
  const recent = await store.create({
    ...input,
    requestId: randomUUID(),
    childThreadId: randomUUID(),
  });
  await store.transition({ id: recent.id, state: "failed" });
  await store.delivered(recent.id);
  const result = await store.maintain({ before: "2999-01-01T00:00:00.000Z" });
  expect(result.compactedTasks).toBe(1);
  expect((await store.get(task.id))?.archived).toBe(true);
  expect((await store.get(task.id))?.summary).toBeUndefined();
  expect((await store.get(undelivered.id))?.error).toBe("Not delivered");
  expect((await store.get(running.id))?.state).toBe("running");
  expect((await store.get(recent.id))?.archived).toBeUndefined();
  expect((await store.create(original)).id).toBe(task.id);
  expect(
    await store
      .create({ ...original, prompt: "Altered old request" })
      .catch((error: unknown) => error),
  ).toMatchObject({ code: "REQUEST_CONFLICT" });
  const owner = await store.forChild(input.projectId, input.childThreadId);
  expect(owner?.id).toBe(task.id);
  expect(owner?.settings.permissionMode).toBe("read-only");
  expect(owner?.designIds).toEqual(original.designIds);
  expect(
    (
      await store.list({
        projectId: input.projectId,
        parentThreadId: input.parentThreadId,
        ids: [task.id],
      })
    ).tasks[0]?.archived,
  ).toBe(true);
  await store.close();
  const restored = new TaskStore(join(directory, "private"));
  stores.push(restored);
  await restored.initialize();
  expect(restored.parentThreadId(input.projectId, input.childThreadId)).toBe(input.parentThreadId);
  expect(
    (await restored.forChild(input.projectId, input.childThreadId))?.settings.permissionMode,
  ).toBe("read-only");
  expect((await restored.create(original)).id).toBe(task.id);
});

test("rich task capacity automatically compacts old delivered results without replaying them", async () => {
  const { store, input, directory } = await fixture();
  const task = await store.create(input);
  await store.transition({ id: task.id, state: "running" });
  await store.transition({ id: task.id, state: "completed" });
  await store.delivered(task.id);
  await ageTasks(directory, [task.id]);
  const { Database } = await import("bun:sqlite");
  const database = new Database(join(directory, "private", "tasks.sqlite"));
  try {
    const template = await store.get(task.id);
    if (!template) throw new Error("Missing seed task.");
    const insert = database.query("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    database.transaction(() => {
      for (let index = 1; index < 10_000; index++) {
        const record = {
          ...template,
          id: randomUUID(),
          requestId: randomUUID(),
          kind: "followup",
          sequence: index + 3,
        };
        insert.run(
          record.id,
          record.projectId,
          record.parentThreadId,
          record.requestId,
          "seed-fingerprint",
          record.state,
          record.sequence,
          1,
          JSON.stringify(record),
        );
      }
      database.exec("UPDATE metadata SET sequence = 10003 WHERE id = 1");
    })();
  } finally {
    database.close();
  }
  const admitted = await store.create({
    ...input,
    childThreadId: randomUUID(),
    requestId: randomUUID(),
  });
  expect(admitted.state).toBe("queued");
  expect((await store.get(task.id))?.archived).toBe(true);
  expect((await store.create(input)).id).toBe(task.id);
});

test("receipt capacity expires only old completed receipts and never forgets used request keys", async () => {
  const { store, directory } = await fixture();
  const { Database } = await import("bun:sqlite");
  const database = new Database(join(directory, "private", "tasks.sqlite"));
  const pending = `canvas-${"a".repeat(64)}`;
  const recent = `canvas-${"b".repeat(64)}`;
  const old = `canvas-${"0".repeat(64)}`;
  try {
    const insert = database.query(
      "INSERT INTO operation_receipts (key, value, updated_at) VALUES (?, ?, ?)",
    );
    database.transaction(() => {
      for (let index = 0; index < 9998; index++)
        insert.run(
          `canvas-${index.toString(16).padStart(64, "0")}`,
          '{"kind":"complete"}',
          oldDate,
        );
      insert.run(pending, '{"kind":"pending"}', oldDate);
      insert.run(recent, '{"kind":"complete"}', new Date().toISOString());
    })();
  } finally {
    database.close();
  }
  const fresh = `canvas-${"c".repeat(64)}`;
  await store.writeReceipt(fresh, { kind: "pending" });
  expect(await store.readReceipt(old).catch((error: unknown) => error)).toMatchObject({
    code: "RECEIPT_EXPIRED",
  });
  expect(
    await store.writeReceipt(old, { kind: "pending" }).catch((error: unknown) => error),
  ).toMatchObject({ code: "RECEIPT_EXPIRED" });
  expect(await store.readReceipt(pending)).toEqual({ kind: "pending" });
  expect(await store.readReceipt(recent)).toEqual({ kind: "complete" });
  expect(await store.readReceipt(fresh)).toEqual({ kind: "pending" });
  expect((await store.maintain({ before: "2999-01-01T00:00:00.000Z" })).expiredReceipts).toBe(100);
  expect(await store.readReceipt(pending)).toEqual({ kind: "pending" });
});

test("incoming message attribution uses private exact content and survives rich history compaction", async () => {
  const { store, input, directory } = await fixture();
  const recipient = randomUUID();
  const message = await store.create({
    ...input,
    kind: "message",
    childThreadId: recipient,
    prompt: "Exact incoming assignment",
  });
  const userMessage = { id: message.id, role: "user" as const, text: message.prompt };
  expect(await store.incomingSources(input.projectId, recipient, [userMessage])).toEqual([
    { messageId: message.id, threadId: input.parentThreadId },
  ]);
  expect(
    await store.incomingSources(input.projectId, recipient, [{ ...userMessage, text: "Altered" }]),
  ).toEqual([]);
  expect(
    await store.incomingSources(input.projectId, recipient, [
      { ...userMessage, role: "assistant" },
    ]),
  ).toEqual([]);
  expect(
    await store.incomingSources(input.projectId, recipient, [
      {
        ...userMessage,
        attachments: [{ id: randomUUID(), name: "Added.txt", mimeType: "text/plain", size: 0 }],
      },
    ]),
  ).toEqual([]);
  expect(await store.incomingSources(randomUUID(), recipient, [userMessage])).toEqual([]);
  expect(await store.incomingSources(input.projectId, randomUUID(), [userMessage])).toEqual([]);
  expect(
    await store.incomingSources(input.projectId, recipient, [{ ...userMessage, id: randomUUID() }]),
  ).toEqual([]);
  await store.transition({ id: message.id, state: "running" });
  await store.transition({ id: message.id, state: "completed" });
  await store.delivered(message.id);
  await ageTasks(directory, [message.id]);
  expect((await store.maintain()).compactedTasks).toBe(1);
  expect((await store.get(message.id))?.prompt).not.toBe(message.prompt);
  expect(await store.incomingSources(input.projectId, recipient, [userMessage])).toEqual([
    { messageId: message.id, threadId: input.parentThreadId },
  ]);
  expect(
    await store.incomingSources(input.projectId, recipient, [{ ...userMessage, text: "Altered" }]),
  ).toEqual([]);
});

test("receiver grants bind registered storage paths and fail closed for legacy or missing scopes", async () => {
  const { store, input, directory } = await fixture();
  await store.setReceiver(input.projectId, input.childThreadId, true);
  const legacyGrant = store.receiverGrant(input.projectId, input.childThreadId);
  await store.close();
  const scopes = new Map<string, string>([[input.projectId, "/registered/project"]]);
  const scoped = new TaskStore(join(directory, "private"), undefined, (id) => scopes.get(id));
  stores.push(scoped);
  await scoped.initialize();
  expect(scoped.receiverGrant(input.projectId, input.childThreadId)).toBeUndefined();
  await scoped.setReceiver(input.projectId, input.childThreadId, true);
  const first = scoped.receiverGrant(input.projectId, input.childThreadId);
  expect(first).toBeDefined();
  expect(first).not.toBe(legacyGrant);
  await scoped.setReceiver(input.projectId, input.childThreadId, true);
  expect(scoped.receiverGrant(input.projectId, input.childThreadId)).toBe(first);
  scopes.set(input.projectId, "/moved/project");
  expect(scoped.receiverGrant(input.projectId, input.childThreadId)).toBeUndefined();
  await scoped.setReceiver(input.projectId, input.childThreadId, true);
  const moved = scoped.receiverGrant(input.projectId, input.childThreadId);
  expect(moved).toBeDefined();
  expect(moved).not.toBe(first);
  scopes.delete(input.projectId);
  expect(scoped.receiverGrant(input.projectId, input.childThreadId)).toBeUndefined();
  expect(
    await scoped
      .setReceiver(input.projectId, input.childThreadId, true)
      .catch((error: unknown) => error),
  ).toMatchObject({ code: "NOT_FOUND" });
  scopes.set(input.projectId, "/moved/project");
  await scoped.close();
  const restored = new TaskStore(join(directory, "private"), undefined, (id) => scopes.get(id));
  stores.push(restored);
  await restored.initialize();
  expect(restored.receiverGrant(input.projectId, input.childThreadId)).toBe(moved);
});

test("the finite tombstone safety cap never evicts used IDs or uncertain receipts", async () => {
  const { store, input, directory } = await fixture();
  const task = await store.create(input);
  await store.transition({ id: task.id, state: "running" });
  await store.transition({ id: task.id, state: "completed" });
  await store.delivered(task.id);
  await ageTasks(directory, [task.id]);
  const pending = `canvas-${"f".repeat(64)}`;
  await store.writeReceipt(pending, { kind: "pending" });
  const { Database } = await import("bun:sqlite");
  const database = new Database(join(directory, "private", "tasks.sqlite"));
  try {
    const insert = database.query("INSERT INTO receipt_tombstones VALUES (?)");
    database.transaction(() => {
      for (let index = 0; index < 100_000; index++)
        insert.run(`canvas-${index.toString(16).padStart(64, "0")}`);
    })();
  } finally {
    database.close();
  }
  expect(await store.maintain()).toMatchObject({ capacityReached: true, compactedTasks: 0 });
  expect((await store.get(task.id))?.archived).toBeUndefined();
  expect((await store.create(input)).id).toBe(task.id);
  expect(
    await store
      .create({ ...input, requestId: randomUUID(), childThreadId: randomUUID() })
      .catch((error: unknown) => error),
  ).toMatchObject({ code: "CAPACITY" });
  expect(
    await store.readReceipt(`canvas-${"0".repeat(64)}`).catch((error: unknown) => error),
  ).toMatchObject({ code: "RECEIPT_EXPIRED" });
  await store.writeReceipt(pending, { kind: "complete" });
  expect(await store.readReceipt(pending)).toEqual({ kind: "complete" });
  expect(
    await store
      .writeReceipt(`canvas-${"e".repeat(64)}`, { kind: "pending" })
      .catch((error: unknown) => error),
  ).toMatchObject({ code: "CAPACITY" });
});
