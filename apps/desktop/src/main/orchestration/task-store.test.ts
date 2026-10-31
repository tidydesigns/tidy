import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, type TaskInput } from "./task-store";

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
