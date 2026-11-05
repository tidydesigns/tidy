import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread } from "../../shared/contracts/desktop";
import type { AgentScope } from "./contracts";
import { TaskStore } from "./task-store";
import { TaskService, inheritedPermissionMode, type TaskHost } from "./task-service";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Assignment did not settle.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tidy-task-service-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new TaskStore(directory);
  await store.initialize();
  const parent: Thread = {
    id: randomUUID(),
    projectId: randomUUID(),
    revision: 0,
    title: "Parent",
    harness: "codex",
    settings: { permissionMode: "default" },
    designIds: [],
    messages: [],
    status: "running",
    updatedAt: new Date().toISOString(),
  };
  const threads = new Map([[parent.id, parent]]);
  const controller = new AbortController();
  const scope: AgentScope = {
    projectId: parent.projectId,
    threadId: parent.id,
    designIds: [],
    writable: true,
    signal: controller.signal,
  };
  let launches = 0;
  const host: TaskHost = {
    async assertCanStartTask() {
      return parent;
    },
    async assertProjectAccess(id) {
      if (id !== parent.projectId) throw new Error("Project denied.");
    },
    async readThread(projectId, id) {
      const thread = threads.get(id);
      if (!thread || thread.projectId !== projectId)
        throw Object.assign(new Error("Thread missing."), { code: "ENOENT" });
      return thread;
    },
    async listThreads() {
      return [];
    },
    async startThread(input) {
      launches++;
      const thread: Thread = {
        ...parent,
        id: input.threadId ?? randomUUID(),
        harness: input.harness,
        settings: input.settings,
        status: "running",
        messages: [],
      };
      threads.set(thread.id, thread);
      return thread;
    },
    async stopThread(_projectId, id) {
      const thread = threads.get(id);
      if (thread) {
        thread.status = "stopped";
        await service.finished(thread);
      }
    },
    async removeResultMessage(input) {
      await input.authorize();
      const thread = await host.readThread(input.projectId, input.threadId);
      thread.queuedMessages = (thread.queuedMessages ?? []).filter(
        (message) => message.id !== input.messageId || !input.texts.includes(message.text),
      );
    },
    async sendMessage(input, guard) {
      await guard?.authorize();
      const thread = await host.readThread(input.projectId, input.threadId);
      thread.queuedMessages = [
        ...(thread.queuedMessages ?? []),
        { id: input.messageId ?? randomUUID(), text: input.text },
      ];
      return thread;
    },
  };
  const service = new TaskService(store, host);
  cleanups.push(() => service.close());
  return {
    directory,
    store,
    service,
    scope,
    parent,
    host,
    threads,
    controller,
    launches: () => launches,
  };
}

test("fast async completion during submission releases execution slots and delivers each result once", async () => {
  const f = await fixture();
  f.host.startThread = async (input) => {
    const child: Thread = {
      ...f.parent,
      id: input.threadId ?? randomUUID(),
      messages: [{ id: randomUUID(), role: "assistant", text: "Verified result" }],
      status: "completed",
    };
    f.threads.set(child.id, child);
    await f.service.finished(child);
    return { ...child, status: "running" };
  };
  const requests = Array.from({ length: 5 }, () => ({
    request_id: randomUUID(),
    prompt: "Inspect",
  }));
  for (const request of requests) await f.service.delegate(f.scope, request);
  await until(async () =>
    (
      await f.store.list({ projectId: f.parent.projectId, parentThreadId: f.parent.id })
    ).tasks.every((task) => task.state === "completed"),
  );
  await f.service.reconcile();
  expect(f.parent.queuedMessages).toHaveLength(5);
  await f.service.reconcile();
  expect(f.parent.queuedMessages).toHaveLength(5);
});

test("completion persistence failures release capacity and retry results without rerunning inference", async () => {
  const f = await fixture();
  const tasks: Awaited<ReturnType<TaskService["delegate"]>>[] = [];
  for (let index = 0; index < 3; index++)
    tasks.push(await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" }));
  await until(async () => f.launches() === 2);
  const child = f.threads.get(tasks[0].child_thread_id);
  if (!child) throw new Error("Missing child.");
  const transition = f.store.transition.bind(f.store);
  let unavailable = true;
  const failures = spyOn(f.store, "transition").mockImplementation(async (input) => {
    if (unavailable && input.id === tasks[0].task_id && input.state === "completed")
      throw new Error("Assignment storage is unavailable.");
    return transition(input);
  });
  cleanups.push(async () => failures.mockRestore());
  child.status = "completed";
  child.messages = [{ id: randomUUID(), role: "assistant", text: "Inspection complete" }];
  await f.service.finished(child);
  await until(async () => f.launches() === 3);
  expect((await f.store.get(tasks[0].task_id))?.state).toBe("running");
  expect(f.parent.queuedMessages ?? []).toHaveLength(0);
  unavailable = false;
  await until(async () => (await f.store.get(tasks[0].task_id))?.state === "completed");
  await f.service.reconcile();
  expect((await f.store.get(tasks[0].task_id))?.summary).toBe("Inspection complete");
  expect(f.parent.queuedMessages).toHaveLength(1);
  await f.service.reconcile();
  expect(f.parent.queuedMessages).toHaveLength(1);
  expect(f.launches()).toBe(3);
});

test("unavailable completion storage settles running assignments and shutdown", async () => {
  const f = await fixture();
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  const child = f.threads.get(task.child_thread_id);
  if (!child) throw new Error("Missing child.");
  const failures = spyOn(f.store, "get").mockRejectedValue(new Error("Storage worker stopped."));
  cleanups.push(async () => failures.mockRestore());
  child.status = "completed";
  await f.service.finished(child);
  await f.service.close();
  expect(f.launches()).toBe(1);
});

test("duplicate assignments launch once and mismatched reuse is rejected", async () => {
  const f = await fixture();
  const input = { request_id: randomUUID(), prompt: "Inspect" };
  const first = await f.service.delegate(f.scope, input);
  const second = await f.service.delegate(f.scope, input);
  expect(second.task_id).toBe(first.task_id);
  await until(async () => f.launches() === 1);
  const error = await f.service
    .delegate(f.scope, { ...input, prompt: "Different" })
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "REQUEST_CONFLICT" });
  expect(f.launches()).toBe(1);
});

test("queued cancellation never starts a worker and ownership is checked", async () => {
  const f = await fixture();
  await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "First" });
  await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Second" });
  await until(async () => f.launches() === 2);
  const pending = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Queued" });
  const denied = await f.service
    .cancel({ ...f.scope, threadId: randomUUID() }, { task_id: pending.task_id })
    .catch((error: unknown) => error);
  expect(denied).toMatchObject({ code: "NOT_FOUND" });
  await f.service.cancel(f.scope, { task_id: pending.task_id });
  expect((await f.store.get(pending.task_id))?.state).toBe("cancelled");
  expect(f.launches()).toBe(2);
});

test("depth enforcement uses persisted lineage after a child is reopened", async () => {
  const f = await fixture();
  await f.store.create({
    projectId: f.parent.projectId,
    parentThreadId: randomUUID(),
    childThreadId: f.parent.id,
    requestId: randomUUID(),
    prompt: "Prior",
    harness: "codex",
    settings: {},
    designIds: [],
    depth: 1,
  });
  const error = await f.service
    .delegate(f.scope, { request_id: randomUUID(), prompt: "Too deep" })
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "FORBIDDEN" });
  expect(f.launches()).toBe(0);
});

test("cross-provider permission inheritance never expands edit autonomy", () => {
  expect(
    inheritedPermissionMode(
      { harness: "claude", settings: { permissionMode: "default" } },
      "codex",
    ),
  ).toBe("read-only");
  expect(
    inheritedPermissionMode(
      { harness: "codex", settings: { permissionMode: "default" } },
      "claude",
    ),
  ).toBe("plan");
  expect(
    inheritedPermissionMode({ harness: "codex", settings: { permissionMode: "auto" } }, "opencode"),
  ).toBe("auto");
  expect(() =>
    inheritedPermissionMode(
      { harness: "claude", settings: { permissionMode: "default" } },
      "opencode",
    ),
  ).toThrow("permission boundary");
});

test("stopped callers cannot delegate or read results", async () => {
  const f = await fixture();
  f.controller.abort(new Error("Stopped"));
  expect(
    await f.service
      .delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" })
      .catch((error: unknown) => error),
  ).toBeInstanceOf(Error);
  expect(await f.service.read(f.scope, {}).catch((error: unknown) => error)).toBeInstanceOf(Error);
  expect(f.launches()).toBe(0);
});

test("revocation during asynchronous admission cannot persist or launch a worker", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = f.store.forChild.bind(f.store);
  f.store.forChild = async (...args) => {
    entered.resolve();
    await release.promise;
    return read(...args);
  };
  const result = f.service
    .delegate(f.scope, { request_id: randomUUID(), prompt: "Review" })
    .catch((error: unknown) => error);
  await entered.promise;
  f.controller.abort(new Error("Parent stopped."));
  release.resolve();
  const error = await result;
  expect(error).toBeInstanceOf(Error);
  expect(f.launches()).toBe(0);
  expect(
    (
      await f.store.list({
        projectId: f.scope.projectId,
        parentThreadId: f.scope.threadId,
        limit: 50,
      })
    ).tasks,
  ).toHaveLength(0);
});

test("a stopped parent cannot launch queued work while its status still says running", async () => {
  const f = await fixture();
  const tasks: Awaited<ReturnType<TaskService["delegate"]>>[] = [];
  for (let index = 0; index < 3; index++)
    tasks.push(
      await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: `Review ${index}` }),
    );
  await until(async () => f.launches() === 2);
  f.host.assertCanStartTask = async () => {
    throw new Error("Parent stopped.");
  };
  const first = f.threads.get(tasks[0].child_thread_id)!;
  first.status = "completed";
  await f.service.finished(first);
  await until(async () => (await f.store.get(tasks[2].task_id))?.state === "failed");
  expect(f.parent.status).toBe("running");
  expect(f.launches()).toBe(2);
});

test("stopping a parent cancels both accepted active and queued assignments", async () => {
  const f = await fixture();
  const tasks: Awaited<ReturnType<TaskService["delegate"]>>[] = [];
  for (let index = 0; index < 3; index++)
    tasks.push(
      await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: `Review ${index}` }),
    );
  await until(async () => f.launches() === 2);
  f.host.assertCanStartTask = async () => {
    throw new Error("Parent stopped.");
  };
  await f.service.cancelParent(f.parent.projectId, f.parent.id);
  await until(async () =>
    (await Promise.all(tasks.map((task) => f.store.get(task.task_id)))).every(
      (task) => task?.state === "cancelled",
    ),
  );
  expect(f.launches()).toBe(2);
});

test("cancellation that loses to completion returns the durable terminal result", async () => {
  const f = await fixture();
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Review" });
  await until(async () => f.launches() === 1);
  const transition = f.store.transition.bind(f.store);
  f.store.transition = async (input) => {
    if (input.id === task.task_id && input.state === "cancel_requested") {
      const child = f.threads.get(task.child_thread_id)!;
      child.status = "completed";
      await f.service.finished(child);
    }
    return transition(input);
  };
  const result = await f.service.cancel(f.scope, { task_id: task.task_id });
  expect(result.state).toBe("completed");
  expect(f.threads.get(task.child_thread_id)?.status).toBe("completed");
});

test("follow-up admission cannot expand the original child's permission grant", async () => {
  const f = await fixture();
  const initial = await f.service.delegate(f.scope, {
    request_id: randomUUID(),
    prompt: "Inspect",
  });
  await until(async () => f.launches() === 1);
  const child = f.threads.get(initial.child_thread_id)!;
  child.status = "completed";
  await f.service.finished(child);
  f.parent.settings = { permissionMode: "auto" };
  child.settings = { permissionMode: "auto" };
  expect(
    await f.service
      .followup(f.scope, {
        thread_id: child.id,
        request_id: randomUUID(),
        message: "Escalated follow up",
      })
      .catch((error: unknown) => error),
  ).toMatchObject({ code: "FORBIDDEN" });
});

test("failed result delivery retries without duplicating the parent message", async () => {
  const f = await fixture();
  const delivered = f.store.delivered.bind(f.store);
  let unavailable = true;
  const failures = spyOn(f.store, "delivered").mockImplementation(async (id) => {
    if (unavailable) throw new Error("Storage unavailable");
    return delivered(id);
  });
  cleanups.push(async () => failures.mockRestore());
  const sends = spyOn(f.host, "sendMessage");
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  const child = f.threads.get(task.child_thread_id)!;
  child.status = "completed";
  await f.service.finished(child);
  await f.service.reconcile();
  expect((await f.store.get(task.task_id))?.deliveryError).toContain("delivery is pending");
  unavailable = false;
  await until(async () => (await f.store.get(task.task_id))?.delivered === true);
  expect(sends).toHaveBeenCalledTimes(1);
  expect((await f.store.get(task.task_id))?.deliveryError).toBeUndefined();
});

test("results remain readable after parent settings change without executing a continuation", async () => {
  const f = await fixture();
  const sends = spyOn(f.host, "sendMessage");
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  f.parent.settings = { permissionMode: "auto" };
  const child = f.threads.get(task.child_thread_id)!;
  child.status = "completed";
  await f.service.finished(child);
  await f.service.reconcile();
  expect((await f.service.read(f.scope, { task_ids: [task.task_id] })).tasks[0].state).toBe(
    "completed",
  );
  expect(sends).not.toHaveBeenCalled();
});

test("cancellation before the launch read settles cannot strand cancel_requested work", async () => {
  const f = await fixture();
  const read = f.store.get.bind(f.store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let block = true;
  f.store.get = async (id) => {
    if (block) {
      block = false;
      entered.resolve();
      await release.promise;
    }
    return read(id);
  };
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await entered.promise;
  await f.service.cancel(f.scope, { task_id: task.task_id });
  release.resolve();
  await until(async () => (await read(task.task_id))?.state === "cancelled");
  expect(f.launches()).toBe(0);
});

test("error-heavy task reads stay byte-bounded and paginate without skipping results", async () => {
  const f = await fixture();
  for (let index = 0; index < 40; index++) {
    const task = await f.store.create({
      projectId: f.parent.projectId,
      parentThreadId: f.parent.id,
      childThreadId: randomUUID(),
      requestId: randomUUID(),
      prompt: "Inspect",
      harness: "codex",
      settings: {},
      designIds: [],
      depth: 1,
    });
    await f.store.transition({ id: task.id, state: "failed", error: "\u0000🧪".repeat(4000) });
  }
  const seen = new Set<string>();
  let cursor = 0;
  while (true) {
    const result = await f.service.read(f.scope, { after: cursor, limit: 100 });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
    if (!result.tasks.length) break;
    for (const task of result.tasks) {
      expect(task.error_truncated).toBe(true);
      expect(seen.has(task.task_id)).toBe(false);
      seen.add(task.task_id);
    }
    expect(result.cursor).toBeGreaterThan(cursor);
    cursor = result.cursor;
  }
  expect(seen.size).toBe(40);
});

test("an expired duplicate admission cannot cancel already accepted queued work", async () => {
  const f = await fixture();
  await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "First" });
  await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Second" });
  await until(async () => f.launches() === 2);
  const request = { request_id: randomUUID(), prompt: "Already accepted" };
  const task = await f.service.delegate(f.scope, request);
  const create = f.store.create.bind(f.store);
  f.store.create = async (...args) => {
    const result = await create(...args);
    f.controller.abort(new Error("Retry turn expired"));
    return result;
  };
  expect(
    await f.service.delegate(f.scope, request).catch((error: unknown) => error),
  ).toBeInstanceOf(Error);
  expect((await f.store.get(task.task_id))?.state).toBe("queued");
});

test("an expired duplicate follow-up cannot cancel its accepted queued run", async () => {
  const f = await fixture();
  const initial = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "First" });
  await until(async () => f.launches() === 1);
  const request = {
    thread_id: initial.child_thread_id,
    request_id: randomUUID(),
    message: "Already accepted followup",
  };
  const task = await f.service.followup(f.scope, request);
  const create = f.store.create.bind(f.store);
  f.store.create = async (...args) => {
    const result = await create(...args);
    f.controller.abort(new Error("Retry turn expired"));
    return result;
  };
  expect(
    await f.service.followup(f.scope, request).catch((error: unknown) => error),
  ).toBeInstanceOf(Error);
  expect((await f.store.get(task.task_id))?.state).toBe("queued");
});

test("delegation preserves effort and Fast mode only for an unchanged harness and model", async () => {
  const f = await fixture();
  f.parent.settings = {
    permissionMode: "auto",
    model: "original-model",
    effort: "xhigh",
    fastMode: true,
  };
  for (const input of [
    { harness: "opencode", model: "other-provider-model", expected: undefined },
    { harness: "claude", expected: undefined },
    { model: "different-model", expected: undefined },
    { model: "original-model", expected: "xhigh" },
    { expected: "xhigh" },
  ]) {
    const { expected, ...selection } = input;
    const result = await f.service.delegate(f.scope, {
      request_id: randomUUID(),
      prompt: "Review",
      ...selection,
    });
    expect((await f.store.get(result.task_id))?.settings.effort).toBe(expected);
    expect((await f.store.get(result.task_id))?.settings.fastMode).toBe(
      expected ? true : undefined,
    );
  }
});

test("batched result waits wake on completion without database polling or parent prompts", async () => {
  const f = await fixture();
  const tasks = await Promise.all(
    ["First", "Second"].map((prompt) =>
      f.service.delegate(f.scope, { request_id: randomUUID(), prompt }),
    ),
  );
  await until(async () => f.launches() === 2);
  const reads = spyOn(f.store, "list");
  const sends = spyOn(f.host, "sendMessage");
  const waiting = f.service.read(f.scope, {
    task_ids: tasks.map((task) => task.task_id),
    wait_ms: 2000,
  });
  await until(async () => reads.mock.calls.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(reads).toHaveBeenCalledTimes(1);
  const child = f.threads.get(tasks[1].child_thread_id)!;
  child.status = "completed";
  child.messages = [{ id: randomUUID(), role: "assistant", text: "Second result" }];
  await f.service.finished(child);
  const result = await waiting;
  expect(result.tasks.find((task) => task.task_id === tasks[1].task_id)).toMatchObject({
    state: "completed",
    summary: "Second result",
    result_source: "worker_reported",
  });
  expect(sends).not.toHaveBeenCalled();
  expect(f.parent.messages).toHaveLength(0);
});

test("wait timeout returns live state without cancelling the child", async () => {
  const f = await fixture();
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  const stop = spyOn(f.host, "stopThread");
  const result = await f.service.read(f.scope, { task_ids: [task.task_id], wait_ms: 20 });
  expect(result.tasks[0].state).toBe("running");
  expect(stop).not.toHaveBeenCalled();
});

test("wait subscription precedes the initial read so completion cannot be missed", async () => {
  const f = await fixture();
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  const list = f.store.list.bind(f.store);
  let first = true;
  const reads = spyOn(f.store, "list").mockImplementation(async (input) => {
    const stale = await list(input);
    if (first) {
      first = false;
      await f.store.transition({
        id: task.task_id,
        state: "completed",
        summary: "Racing completion",
      });
    }
    return stale;
  });
  cleanups.push(async () => reads.mockRestore());
  const result = await f.service.read(f.scope, { task_ids: [task.task_id], wait_ms: 2000 });
  expect(result.tasks[0].summary).toBe("Racing completion");
  expect(reads).toHaveBeenCalledTimes(2);
});

test("waits respect ownership, cursors, cancellation and subscription cleanup", async () => {
  const f = await fixture();
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  const child = f.threads.get(task.child_thread_id)!;
  child.status = "completed";
  await f.service.finished(child);
  const result = await f.service.read(f.scope, { task_ids: [task.task_id] });
  const unchanged = await f.service.read(f.scope, { after: result.cursor, wait_ms: 10 });
  expect(unchanged.tasks).toHaveLength(0);
  const foreign = await f.service.read(
    { ...f.scope, threadId: randomUUID() },
    { task_ids: [task.task_id], wait_ms: 10 },
  );
  expect(foreign.tasks).toHaveLength(0);
  const subscribe = f.store.subscribe.bind(f.store);
  let activeSubscriptions = 0;
  const subscriptions = spyOn(f.store, "subscribe").mockImplementation((listener) => {
    activeSubscriptions++;
    const unsubscribe = subscribe(listener);
    return () => {
      activeSubscriptions--;
      unsubscribe();
    };
  });
  cleanups.push(async () => subscriptions.mockRestore());
  const waiting = f.service.read(f.scope, { after: result.cursor, wait_ms: 2000 });
  await until(async () => activeSubscriptions === 1);
  f.controller.abort(new Error("Turn ended"));
  await expect(waiting).rejects.toThrow("Turn ended");
  expect(activeSubscriptions).toBe(0);
});

test("closing the scheduler releases result waits", async () => {
  const f = await fixture();
  const subscribed = spyOn(f.store, "subscribe");
  const waiting = f.service.read(f.scope, { wait_ms: 2000 });
  await until(async () => subscribed.mock.calls.length === 1);
  const closing = f.service.close();
  await expect(waiting).rejects.toThrow("Assignments are closing");
  await closing;
});

test("wait delegation returns fast results directly without queueing a continuation", async () => {
  const f = await fixture();
  f.host.startThread = async (input) => {
    const child: Thread = {
      ...f.parent,
      id: input.threadId!,
      messages: [{ id: randomUUID(), role: "assistant", text: "Direct result" }],
      status: "completed",
    };
    f.threads.set(child.id, child);
    await f.service.finished(child);
    return child;
  };
  const sends = spyOn(f.host, "sendMessage");
  const result = await f.service.delegate(f.scope, {
    request_id: randomUUID(),
    prompt: "Inspect",
    mode: "wait",
    timeout_ms: 1000,
  });
  expect(result).toMatchObject({
    state: "completed",
    summary: "Direct result",
    wait_timed_out: false,
  });
  await f.service.reconcile();
  expect(sends).not.toHaveBeenCalled();
  expect((await f.store.get(result.task_id))?.delivered).toBe(true);
});

test("wait timeouts leave children running and restore a single background delivery", async () => {
  const f = await fixture();
  const result = await f.service.delegate(f.scope, {
    request_id: randomUUID(),
    prompt: "Inspect",
    mode: "wait",
    timeout_ms: 20,
  });
  expect(result).toMatchObject({ state: "running", wait_timed_out: true });
  expect(f.parent.queuedMessages ?? []).toHaveLength(0);
  const child = f.threads.get(result.child_thread_id)!;
  child.status = "completed";
  child.messages = [{ id: randomUUID(), role: "assistant", text: "Later result" }];
  await f.service.finished(child);
  await f.service.reconcile();
  expect(f.parent.queuedMessages).toHaveLength(1);
  expect(f.parent.queuedMessages![0].text).toContain("Later result");
  await f.service.reconcile();
  expect(f.parent.queuedMessages).toHaveLength(1);
});

test("a cancelled wait restores delivery without cancelling independent child execution", async () => {
  const f = await fixture();
  const waiting = f.service
    .delegate(f.scope, {
      request_id: randomUUID(),
      prompt: "Inspect",
      mode: "wait",
      timeout_ms: 1000,
    })
    .catch((error: unknown) => error);
  await until(async () => f.launches() === 1);
  f.controller.abort(new Error("Disconnected"));
  expect(await waiting).toBeInstanceOf(Error);
  const child = [...f.threads.values()].find((thread) => thread.id !== f.parent.id)!;
  expect(child.status).toBe("running");
  child.status = "completed";
  await f.service.finished(child);
  await f.service.reconcile();
  expect(f.parent.queuedMessages).toHaveLength(1);
});

test("reading a delivered result removes its queued continuation and durably acknowledges it", async () => {
  const f = await fixture();
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  const child = f.threads.get(task.child_thread_id)!;
  child.status = "completed";
  await f.service.finished(child);
  await f.service.reconcile();
  expect(f.parent.queuedMessages).toHaveLength(1);
  const unrelated = { id: randomUUID(), text: "User instruction" };
  f.parent.queuedMessages!.push(unrelated);
  await f.service.read(f.scope, { task_ids: [task.task_id] });
  await f.service.reconcile();
  expect(f.parent.queuedMessages).toEqual([unrelated]);
  expect((await f.store.get(task.task_id))?.delivered).toBe(true);
});

test("delivery rechecks permission changes and retries only under the original grant", async () => {
  const f = await fixture();
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  f.parent.settings = { permissionMode: "auto" };
  const child = f.threads.get(task.child_thread_id)!;
  child.status = "completed";
  await f.service.finished(child);
  await f.service.reconcile();
  expect(f.parent.queuedMessages ?? []).toHaveLength(0);
  expect((await f.store.get(task.task_id))?.deliveryError).toContain("permissions changed");
  f.parent.settings = { permissionMode: "default" };
  await f.service.reconcile();
  expect(f.parent.queuedMessages).toHaveLength(1);
});

test("retrying an async delegation in wait mode reuses its child and suppresses duplicate delivery", async () => {
  const f = await fixture();
  const request = { request_id: randomUUID(), prompt: "Inspect" };
  const task = await f.service.delegate(f.scope, request);
  await until(async () => f.launches() === 1);
  const subscribed = spyOn(f.store, "subscribe");
  const waiting = f.service.delegate(f.scope, { ...request, mode: "wait", timeout_ms: 1000 });
  await until(async () => subscribed.mock.calls.length > 0);
  const child = f.threads.get(task.child_thread_id)!;
  child.status = "completed";
  await f.service.finished(child);
  expect(await waiting).toMatchObject({
    task_id: task.task_id,
    state: "completed",
    wait_timed_out: false,
  });
  await f.service.reconcile();
  expect(f.parent.queuedMessages ?? []).toHaveLength(0);
  expect(f.launches()).toBe(1);
});

test("cancelling a completed task disposes its still-queued notification", async () => {
  const f = await fixture();
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  const child = f.threads.get(task.child_thread_id)!;
  child.status = "completed";
  await f.service.finished(child);
  await f.service.reconcile();
  expect(f.parent.queuedMessages).toHaveLength(1);
  expect(await f.service.cancel(f.scope, { task_id: task.task_id })).toMatchObject({
    state: "completed",
  });
  await f.service.reconcile();
  expect(f.parent.queuedMessages ?? []).toHaveLength(0);
});

test("a failed batch result handoff restores every removed completion notification", async () => {
  const f = await fixture();
  const tasks = await Promise.all(
    ["First", "Second"].map((prompt) =>
      f.service.delegate(f.scope, { request_id: randomUUID(), prompt }),
    ),
  );
  await until(async () => f.launches() === 2);
  for (const task of tasks) {
    const child = f.threads.get(task.child_thread_id)!;
    child.status = "completed";
    await f.service.finished(child);
  }
  await f.service.reconcile();
  expect(f.parent.queuedMessages).toHaveLength(2);
  const remove = f.host.removeResultMessage.bind(f.host);
  let removals = 0;
  f.host.removeResultMessage = async (input) => {
    if (++removals === 2) throw new Error("Queue persistence failed");
    await remove(input);
  };
  const result = await f.service
    .read(f.scope, { task_ids: tasks.map((task) => task.task_id) })
    .catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  f.host.removeResultMessage = remove;
  await f.service.reconcile();
  expect(new Set(f.parent.queuedMessages?.map((message) => message.id))).toEqual(
    new Set(tasks.map((task) => task.task_id)),
  );
  expect(f.parent.queuedMessages).toHaveLength(2);
});

test("a prepared result stays pending and restores its notification after a rejected handoff", async () => {
  const f = await fixture();
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  const child = f.threads.get(task.child_thread_id)!;
  child.status = "completed";
  await f.service.finished(child);
  await f.service.reconcile();
  const observation = f.service.resultDelivery(f.scope);
  await f.service.read(f.scope, { task_ids: [task.task_id] }, observation);
  expect((await f.store.get(task.task_id))?.delivered).toBe(false);
  expect(f.parent.queuedMessages ?? []).toHaveLength(0);
  await observation.settle(false);
  await f.service.reconcile();
  expect(f.parent.queuedMessages).toHaveLength(1);
});

test("a flushed result is acknowledged even when its owning turn ends immediately afterward", async () => {
  const f = await fixture();
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  const child = f.threads.get(task.child_thread_id)!;
  child.status = "completed";
  await f.service.finished(child);
  await f.service.reconcile();
  const delivery = f.service.resultDelivery(f.scope);
  await f.service.read(f.scope, { task_ids: [task.task_id] }, delivery);
  f.controller.abort(new Error("Turn completed after receiving its result"));
  await delivery.settle(true);
  await f.service.reconcile();
  expect((await f.store.get(task.task_id))?.delivered).toBe(true);
  expect(f.parent.queuedMessages ?? []).toHaveLength(0);
});

test("acknowledgement storage failure after a flushed response retains a single fallback notification", async () => {
  const f = await fixture();
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  const child = f.threads.get(task.child_thread_id)!;
  child.status = "completed";
  await f.service.finished(child);
  await f.service.reconcile();
  const delivery = f.service.resultDelivery(f.scope);
  const result = await f.service.read(f.scope, { task_ids: [task.task_id] }, delivery);
  expect(result.tasks[0].state).toBe("completed");
  const unavailable = spyOn(f.store, "delivered").mockRejectedValue(
    new Error("Storage unavailable"),
  );
  cleanups.push(async () => unavailable.mockRestore());
  await delivery.settle(true);
  await f.service.reconcile();
  expect(f.parent.queuedMessages).toHaveLength(1);
  expect((await f.store.get(task.task_id))?.delivered).toBe(false);
  unavailable.mockRestore();
  await f.service.reconcile();
  expect(f.parent.queuedMessages).toHaveLength(1);
  expect((await f.store.get(task.task_id))?.delivered).toBe(true);
});

test("failed child notifications include the error when no summary was produced", async () => {
  const f = await fixture();
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  const child = f.threads.get(task.child_thread_id)!;
  child.status = "failed";
  child.error = "Worker could not read the requested file";
  child.messages = [];
  await f.service.finished(child);
  await f.service.reconcile();
  expect(f.parent.queuedMessages?.[0].text).toContain(child.error);
});

test("failed notifications preserve partial work and bound long error details to the queue budget", async () => {
  const f = await fixture();
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  const child = f.threads.get(task.child_thread_id)!;
  child.status = "failed";
  child.messages = [
    { id: randomUUID(), role: "assistant", text: "Partial findings: " + "x".repeat(16000) },
  ];
  child.error = "Worker file access failed: " + "y".repeat(16000);
  await f.service.finished(child);
  await f.service.reconcile();
  const message = f.parent.queuedMessages![0];
  const { queuedMessageSchema } = await import("../../shared/contracts/message-queue");
  expect(queuedMessageSchema.safeParse(message).success).toBe(true);
  expect(message.text).toContain("Error: Worker file access failed");
  expect(message.text).toContain("Error truncated");
  expect(message.text).toContain("x".repeat(100));
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function durableTask(f: Fixture, input: Partial<Parameters<TaskStore["create"]>[0]> = {}) {
  return f.store.create({
    projectId: f.parent.projectId,
    parentThreadId: f.parent.id,
    childThreadId: randomUUID(),
    requestId: randomUUID(),
    prompt: "Continue the assignment",
    harness: "codex",
    settings: { permissionMode: "default" },
    parentGrant: { harness: "codex", permissionMode: "default" },
    designIds: [],
    depth: 1,
    ...input,
  });
}
async function reopenTasks(f: Fixture) {
  await f.service.pauseForRestart();
  await f.store.close();
  const store = new TaskStore(f.directory);
  await store.initialize();
  const service = new TaskService(store, f.host);
  cleanups.push(() => service.close());
  return { store, service };
}
function childFor(
  f: Fixture,
  task: Awaited<ReturnType<typeof durableTask>>,
  status: Thread["status"] = "interrupted",
) {
  const child: Thread = {
    ...f.parent,
    id: task.childThreadId,
    status,
    messages: [{ id: task.id, role: "user", text: task.prompt }],
    designIds: task.designIds,
    settings: task.settings,
  };
  f.threads.set(child.id, child);
  return child;
}

test("restart re-admits queued tasks within scheduler limits and repeated recovery launches once", async () => {
  const f = await fixture();
  const tasks = [];
  for (let index = 0; index < 5; index++) tasks.push(await durableTask(f));
  const { service, store } = await reopenTasks(f);
  await Promise.all([service.recover(), service.recover()]);
  await until(async () => f.launches() === 2);
  await service.recover();
  expect(f.launches()).toBe(2);
  const states = await Promise.all(tasks.map((task) => store.get(task.id)));
  expect(states.filter((task) => task?.state === "running")).toHaveLength(2);
  expect(states.filter((task) => task?.state === "queued")).toHaveLength(3);
  await service.cancel(f.scope, { task_id: tasks[4].id });
  const first = f.threads.get(tasks[0].childThreadId)!;
  first.status = "completed";
  await service.finished(first);
  await until(async () => f.launches() === 3);
  expect((await store.get(tasks[4].id))?.state).toBe("cancelled");
});

test("restart continues an existing child once without creating a child or another user bubble", async () => {
  const f = await fixture();
  const task = await durableTask(f);
  await f.store.transition({ id: task.id, state: "running" });
  const child = childFor(f, task);
  let resumes = 0;
  f.host.resumeThread = async (_projectId, id, authorize) => {
    await authorize?.();
    expect(id).toBe(child.id);
    resumes++;
    child.status = "running";
    return child;
  };
  const { service, store } = await reopenTasks(f);
  await service.recover();
  await until(async () => resumes === 1);
  await service.recover();
  expect(resumes).toBe(1);
  expect(f.launches()).toBe(0);
  expect(child.messages.filter((message) => message.role === "user")).toHaveLength(1);
  child.messages.push({ id: randomUUID(), role: "assistant", text: "Recovered result" });
  child.status = "completed";
  await service.finished(child);
  await service.reconcile();
  await service.recover();
  expect((await store.get(task.id))?.summary).toBe("Recovered result");
  expect(f.parent.queuedMessages).toHaveLength(1);
});

test("restart reconciles already completed children without resuming inference", async () => {
  const f = await fixture();
  const task = await durableTask(f);
  await f.store.transition({ id: task.id, state: "running" });
  const child = childFor(f, task, "completed");
  child.messages.push({ id: randomUUID(), role: "assistant", text: "Finished before the crash" });
  const resume = spyOn(f.host, "startThread");
  cleanups.push(async () => resume.mockRestore());
  const { service, store } = await reopenTasks(f);
  await service.recover();
  await until(async () => (await store.get(task.id))?.state === "completed");
  expect(resume).not.toHaveBeenCalled();
  expect((await store.get(task.id))?.summary).toBe("Finished before the crash");
});

test("recovered follow-ups continue their existing task message and scope result summaries", async () => {
  const f = await fixture();
  const initial = await durableTask(f);
  await f.store.transition({ id: initial.id, state: "running" });
  await f.store.transition({ id: initial.id, state: "completed" });
  await f.store.delivered(initial.id);
  const followup = await durableTask(f, { kind: "followup", childThreadId: initial.childThreadId });
  await f.store.transition({ id: followup.id, state: "running" });
  const child = childFor(f, followup);
  child.messages.unshift({
    id: randomUUID(),
    role: "assistant",
    text: "Previous unrelated answer",
  });
  let resumes = 0;
  f.host.resumeThread = async (_project, _thread, authorize) => {
    await authorize?.();
    resumes++;
    child.status = "running";
    return child;
  };
  const send = spyOn(f.host, "sendMessage");
  cleanups.push(async () => send.mockRestore());
  const { service, store } = await reopenTasks(f);
  await service.recover();
  await until(async () => resumes === 1);
  expect(send).not.toHaveBeenCalled();
  child.messages.push({ id: randomUUID(), role: "assistant", text: "Follow-up result" });
  child.status = "completed";
  await service.finished(child);
  expect((await store.get(followup.id))?.summary).toBe("Follow-up result");
  expect(child.messages.filter((message) => message.id === followup.id)).toHaveLength(1);
});

test("recovery rechecks parent, child, design, and incoming receiver grants before resuming", async () => {
  for (const changed of ["parent", "child", "design", "receiver", "legacy"] as const) {
    const f = await fixture();
    const recipient = randomUUID();
    if (changed === "receiver") await f.store.setReceiver(f.parent.projectId, recipient, true);
    const task = await durableTask(f, {
      ...(changed === "receiver"
        ? {
            kind: "message" as const,
            childThreadId: recipient,
            recipientGrant: f.store.receiverGrant(f.parent.projectId, recipient),
          }
        : {}),
      ...(changed === "legacy" ? { parentGrant: undefined } : {}),
    });
    await f.store.transition({ id: task.id, state: "running" });
    const child = childFor(f, task);
    let resumes = 0;
    f.host.resumeThread = async () => {
      resumes++;
      return child;
    };
    const { service, store } = await reopenTasks(f);
    if (changed === "parent") f.parent.settings = { permissionMode: "auto" };
    if (changed === "child") child.settings = { permissionMode: "auto" };
    if (changed === "design") child.designIds = [randomUUID()];
    if (changed === "receiver") {
      await store.setReceiver(f.parent.projectId, recipient, false);
      await store.setReceiver(f.parent.projectId, recipient, true);
    }
    await service.recover();
    await until(async () => (await store.get(task.id))?.state === "failed");
    expect(resumes).toBe(0);
    expect(f.launches()).toBe(0);
  }
});

test("restart preserves cancellation and never resumes an incoming task or stops unrelated work", async () => {
  const f = await fixture();
  const recipient = randomUUID();
  await f.store.setReceiver(f.parent.projectId, recipient, true);
  const task = await durableTask(f, {
    kind: "message",
    childThreadId: recipient,
    recipientGrant: f.store.receiverGrant(f.parent.projectId, recipient),
  });
  await f.store.transition({ id: task.id, state: "running" });
  await f.store.transition({ id: task.id, state: "cancel_requested" });
  const child = childFor(f, task, "running");
  child.messages.push({ id: randomUUID(), role: "user", text: "Unrelated user request" });
  let stopped = 0;
  let resumed = 0;
  let exactStops = 0;
  f.host.stopThread = async () => {
    stopped++;
  };
  f.host.stopTaskTurn = async (_project, _thread, taskId) => {
    expect(taskId).toBe(task.id);
    exactStops++;
    return false;
  };
  f.host.resumeThread = async () => {
    resumed++;
    return child;
  };
  const { service, store } = await reopenTasks(f);
  await service.recover();
  await until(async () => (await store.get(task.id))?.state === "cancelled");
  expect(resumed).toBe(0);
  expect(stopped).toBe(0);
  expect(exactStops).toBe(1);
  expect(child.status).toBe("running");
});

test("cancellation during resume preparation wins at the final authorization boundary", async () => {
  const f = await fixture();
  const task = await durableTask(f);
  await f.store.transition({ id: task.id, state: "running" });
  const child = childFor(f, task);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let submissions = 0;
  f.host.resumeThread = async (_project, _thread, authorize) => {
    entered.resolve();
    await release.promise;
    await authorize?.();
    submissions++;
    return child;
  };
  const { service, store } = await reopenTasks(f);
  await service.recover();
  await entered.promise;
  await service.cancel(f.scope, { task_id: task.id });
  release.resolve();
  await until(async () => (await store.get(task.id))?.state === "cancelled");
  expect(submissions).toBe(0);
});

test("planned restart suppresses finish delivery and failed restart resumes stopped children", async () => {
  const f = await fixture();
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  const child = f.threads.get(task.child_thread_id)!;
  let resumes = 0;
  f.host.resumeThread = async (_project, _thread, authorize) => {
    await authorize?.();
    resumes++;
    child.status = "running";
    return child;
  };
  await f.service.pauseForRestart();
  child.status = "stopped";
  await f.service.cancelParent(f.parent.projectId, f.parent.id);
  await f.service.finished(child);
  await f.service.reconcile();
  expect((await f.store.get(task.task_id))?.state).toBe("running");
  expect(f.parent.queuedMessages ?? []).toHaveLength(0);
  expect(
    await f.service
      .delegate(f.scope, { request_id: randomUUID(), prompt: "Blocked" })
      .catch((error: unknown) => error),
  ).toMatchObject({ code: "UNAVAILABLE" });
  expect(f.service.resumeAfterRestartFailure()).toBeUndefined();
  expect(resumes).toBe(0);
  await f.service.recover();
  await until(async () => resumes === 1);
  expect(f.launches()).toBe(1);
  expect((await f.store.get(task.task_id))?.state).toBe("running");
});

test("pause waits for in-flight preparation and blocks its eventual provider submission", async () => {
  const f = await fixture();
  const task = await durableTask(f);
  await f.store.transition({ id: task.id, state: "running" });
  const child = childFor(f, task);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let submissions = 0;
  f.host.resumeThread = async (_project, _thread, authorize) => {
    entered.resolve();
    await release.promise;
    await authorize?.();
    submissions++;
    return child;
  };
  await f.service.recover();
  await entered.promise;
  const paused = f.service.pauseForRestart();
  release.resolve();
  await paused;
  expect(submissions).toBe(0);
  expect((await f.store.get(task.id))?.state).toBe("running");
});

test("provider failures retry under scheduler ownership and never repost the initial prompt", async () => {
  const f = await fixture();
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.launches() === 1);
  const child = f.threads.get(task.child_thread_id)!;
  let resumes = 0;
  f.host.resumeThread = async (_project, _thread, authorize) => {
    await authorize?.();
    resumes++;
    child.status = "running";
    return child;
  };
  child.status = "failed";
  await f.service.finished(child);
  await f.service.finished(child);
  expect((await f.store.get(task.task_id))?.state).toBe("running");
  expect(resumes).toBe(0);
  await until(async () => resumes === 1);
  expect(f.launches()).toBe(1);
  expect(f.parent.queuedMessages ?? []).toHaveLength(0);
  child.status = "completed";
  await f.service.finished(child);
  expect((await f.store.get(task.task_id))?.state).toBe("completed");
});

test("host retry waits remain an active scheduler slot and cannot admit another child turn", async () => {
  const f = await fixture();
  const task = await durableTask(f);
  await f.store.transition({ id: task.id, state: "running" });
  const child = childFor(f, task);
  let waiting = true;
  f.host.isThreadRunning = (_project, id) => id === child.id && waiting;
  let resumes = 0;
  f.host.resumeThread = async () => {
    resumes++;
    return child;
  };
  const { service, store } = await reopenTasks(f);
  await service.recover();
  await until(async () => Reflect.get(service, "byChild").has(child.id));
  await service.finished(child);
  await service.recover();
  expect(resumes).toBe(0);
  expect((await store.get(task.id))?.state).toBe("running");
  waiting = false;
  child.status = "completed";
  await service.finished(child);
  expect((await store.get(task.id))?.state).toBe("completed");
});

test("permanent provider errors settle delegated tasks instead of scheduling endless retries", async () => {
  const f = await fixture();
  f.host.resumeThread = async () => {
    throw new Error("A permanent provider error must not be retried.");
  };
  const task = await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => (await f.store.get(task.task_id))?.state === "running");
  const record = (await f.store.get(task.task_id))!;
  const child = f.threads.get(record.childThreadId)!;
  child.status = "failed";
  child.errorKind = "request";
  child.error = "The provider rejected this request.";
  await f.service.finished(child);
  expect((await f.store.get(task.task_id))?.state).toBe("failed");
  expect(Reflect.get(f.service, "retryAt").has(task.task_id)).toBe(false);
  expect(f.launches()).toBe(1);
});

test("ordinary task ownership survives restart before scheduler recovery and throughout retry waits", async () => {
  const f = await fixture();
  const recipient = randomUUID();
  await f.store.setReceiver(f.parent.projectId, recipient, true);
  const task = await durableTask(f, {
    kind: "message",
    childThreadId: recipient,
    recipientGrant: f.store.receiverGrant(f.parent.projectId, recipient),
  });
  await f.store.transition({ id: task.id, state: "running" });
  const child = childFor(f, task);
  f.host.resumeThread = async (_project, _thread, authorize) => {
    await authorize?.();
    child.status = "failed";
    return child;
  };
  const { service, store } = await reopenTasks(f);
  expect(service.isManagedExecution(f.parent.projectId, recipient)).toBe(true);
  expect(service.isManagedExecution(randomUUID(), recipient)).toBe(false);
  await service.recover();
  await until(async () => Reflect.get(service, "retryAt").has(task.id));
  expect(service.isManagedExecution(f.parent.projectId, recipient)).toBe(true);
  await service.cancel(f.scope, { task_id: task.id });
  expect((await store.get(task.id))?.state).toBe("cancelled");
  await until(async () => !Reflect.get(service, "active").has(task.id));
  expect(service.isManagedExecution(f.parent.projectId, recipient)).toBe(false);
});

test("stopping a parent before recover cancels durable queued and running tasks", async () => {
  const f = await fixture();
  const queued = await durableTask(f);
  const running = await durableTask(f);
  await f.store.transition({ id: running.id, state: "running" });
  childFor(f, running);
  let resumes = 0;
  f.host.resumeThread = async () => {
    resumes++;
    return f.parent;
  };
  const { service, store } = await reopenTasks(f);
  await service.cancelParent(f.parent.projectId, f.parent.id);
  await service.recover();
  expect((await store.get(queued.id))?.state).toBe("cancelled");
  expect((await store.get(running.id))?.state).toBe("cancelled");
  expect(resumes).toBe(0);
  expect(f.launches()).toBe(0);
});

test("a task prompt already in the durable child queue is resumed without resending", async () => {
  const f = await fixture();
  const recipient = randomUUID();
  await f.store.setReceiver(f.parent.projectId, recipient, true);
  const task = await durableTask(f, {
    kind: "message",
    childThreadId: recipient,
    recipientGrant: f.store.receiverGrant(f.parent.projectId, recipient),
  });
  await f.store.transition({ id: task.id, state: "running" });
  const child = childFor(f, task, "completed");
  child.messages = [{ id: randomUUID(), role: "user", text: "Earlier request" }];
  child.queuedMessages = [{ id: task.id, text: task.prompt }];
  let resumes = 0;
  f.host.resumeThread = async (_project, _thread, authorize) => {
    await authorize?.();
    resumes++;
    child.queuedMessages = [];
    child.messages.push({ id: task.id, role: "user", text: task.prompt });
    child.status = "running";
    return child;
  };
  const send = spyOn(f.host, "sendMessage");
  cleanups.push(async () => send.mockRestore());
  const { service } = await reopenTasks(f);
  await service.recover();
  await until(async () => resumes === 1);
  expect(send).not.toHaveBeenCalled();
  expect(child.messages.filter((message) => message.id === task.id)).toHaveLength(1);
});

test("recovery retries transient storage outages without another manual recovery call", async () => {
  const f = await fixture();
  const task = await durableTask(f);
  const read = f.store.unfinished.bind(f.store);
  let reads = 0;
  const unavailable = spyOn(f.store, "unfinished").mockImplementation(async (...args) => {
    if (++reads === 1) throw new Error("Worker temporarily unavailable.");
    return read(...args);
  });
  cleanups.push(async () => unavailable.mockRestore());
  expect(await f.service.recover().catch((error: unknown) => error)).toBeInstanceOf(Error);
  await until(async () => f.launches() === 1);
  expect((await f.store.get(task.id))?.state).toBe("running");
});

test("expired host retry waits are re-admitted by recover without losing scheduler ownership", async () => {
  const f = await fixture();
  const task = await durableTask(f);
  await f.store.transition({ id: task.id, state: "running" });
  const child = childFor(f, task);
  let waiting = true;
  let resumes = 0;
  f.host.isThreadRunning = () => waiting;
  f.host.resumeThread = async (_project, _thread, authorize) => {
    await authorize?.();
    resumes++;
    waiting = true;
    child.status = "running";
    return child;
  };
  await f.service.recover();
  await until(async () => Reflect.get(f.service, "waiting").has(task.id));
  await f.service.recover();
  expect(resumes).toBe(0);
  waiting = false;
  await f.service.recover();
  await until(async () => resumes === 1);
  await f.service.recover();
  expect(resumes).toBe(1);
  expect((await f.store.get(task.id))?.state).toBe("running");
});

test("parent cancellation drains a recovered queue larger than storage admission without losing intent", async () => {
  const f = await fixture();
  const tasks = [];
  for (let index = 0; index < 105; index++) tasks.push(await durableTask(f));
  const unrelated = await durableTask(f, { parentThreadId: randomUUID() });
  const { service, store } = await reopenTasks(f);
  await service.cancelParent(f.parent.projectId, f.parent.id);
  for (const task of tasks) expect((await store.get(task.id))?.state).toBe("cancelled");
  expect((await store.get(unrelated.id))?.state).toBe("queued");
  expect(f.launches()).toBe(0);
});

test("close preserves queued and running tasks for the next scheduler instead of cancelling them", async () => {
  const f = await fixture();
  const tasks = [];
  for (let index = 0; index < 3; index++)
    tasks.push(
      await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: `Inspect ${index}` }),
    );
  await until(async () => f.launches() === 2);
  await f.service.close();
  const restored = new TaskStore(f.directory);
  cleanups.push(() => restored.close());
  await restored.initialize();
  const states = await Promise.all(
    tasks.map(async (task) => (await restored.get(task.task_id))?.state),
  );
  expect(states).toEqual(["running", "running", "queued"]);
  expect(await restored.pendingDeliveries()).toEqual([]);
});

async function providerRetryWait() {
  const f = await fixture();
  const task = await durableTask(f);
  await f.store.transition({ id: task.id, state: "running" });
  const child = childFor(f, task, "running");
  child.recovery = { reason: "provider", attempt: 2, retryAt: "2000-01-01T00:00:00.000Z" };
  f.host.isThreadRunning = (_project, id) => id === child.id;
  await f.service.recover();
  await until(async () => Reflect.get(f.service, "waiting").has(task.id));
  return { ...f, task, child };
}

test("retryThread bypasses a provider retry wait, coalesces calls, and retains the active scheduler slot", async () => {
  const f = await providerRetryWait();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let resumes = 0;
  f.host.resumeThread = async (_project, _thread, authorize) => {
    entered.resolve();
    await release.promise;
    await authorize?.();
    resumes++;
    return f.child;
  };
  const send = spyOn(f.host, "sendMessage");
  cleanups.push(async () => send.mockRestore());
  const first = f.service.retryThread(f.parent.projectId, f.child.id);
  const duplicate = f.service.retryThread(f.parent.projectId, f.child.id);
  expect(first).toBe(duplicate);
  await entered.promise;
  // The retry timer has expired, but provider submission is still preparing.
  f.host.isThreadRunning = () => false;
  await f.service.recover();
  expect(Reflect.get(f.service, "active").size).toBe(1);
  release.resolve();
  expect(await first).toBe(f.child);
  expect(await duplicate).toBe(f.child);
  expect(resumes).toBe(1);
  expect(Reflect.get(f.service, "active").size).toBe(1);
  expect(f.child.recovery?.attempt).toBe(2);
  expect(f.child.messages.filter((message) => message.role === "user")).toHaveLength(1);
  expect(send).not.toHaveBeenCalled();
  expect(f.launches()).toBe(0);
  f.child.status = "completed";
  await f.service.finished(f.child);
  expect((await f.store.get(f.task.id))?.state).toBe("completed");
});

test("retryThread re-admits a durable running recipient task without duplicating its prompt", async () => {
  const f = await fixture();
  const recipient = randomUUID();
  await f.store.setReceiver(f.parent.projectId, recipient, true);
  const task = await durableTask(f, {
    kind: "message",
    childThreadId: recipient,
    recipientGrant: f.store.receiverGrant(f.parent.projectId, recipient),
  });
  await f.store.transition({ id: task.id, state: "running" });
  const child = childFor(f, task, "running");
  child.recovery = { reason: "provider", attempt: 3, retryAt: "2000-01-01T00:00:00.000Z" };
  f.host.isThreadRunning = () => true;
  let resumes = 0;
  f.host.resumeThread = async (_project, _thread, authorize) => {
    await authorize?.();
    resumes++;
    return child;
  };
  const { service, store } = await reopenTasks(f);
  expect(await service.retryThread(f.parent.projectId, child.id)).toBe(child);
  expect(resumes).toBe(1);
  expect(Reflect.get(service, "active").size).toBe(1);
  child.messages.push({ id: randomUUID(), role: "assistant", text: "Recovered recipient result" });
  child.status = "completed";
  await service.finished(child);
  expect((await store.get(task.id))?.summary).toBe("Recovered recipient result");
  expect(child.messages.filter((message) => message.id === task.id)).toHaveLength(1);
});

test("retryThread queues durable retries behind scheduler limits and forces resume only on admission", async () => {
  const f = await fixture();
  for (let index = 0; index < 2; index++)
    await f.service.delegate(f.scope, { request_id: randomUUID(), prompt: `Hold slot ${index}` });
  await until(async () => f.launches() === 2);
  const task = await durableTask(f);
  await f.store.transition({ id: task.id, state: "running" });
  const child = childFor(f, task, "running");
  f.host.isThreadRunning = () => true;
  let resumes = 0;
  f.host.resumeThread = async (_project, _thread, authorize) => {
    await authorize?.();
    resumes++;
    return child;
  };
  expect(await f.service.retryThread(f.parent.projectId, child.id)).toBeUndefined();
  expect(resumes).toBe(0);
  expect(Reflect.get(f.service, "active").size).toBe(2);
  const first = [...f.threads.values()].find(
    (thread) => thread.id !== f.parent.id && thread.id !== child.id,
  )!;
  first.status = "completed";
  await f.service.finished(first);
  await until(async () => resumes === 1);
  expect(Reflect.get(f.service, "active").size).toBe(2);
});

test("retryThread rejects revoked active grants and releases the original execution slot", async () => {
  const f = await providerRetryWait();
  let resumed = false;
  f.host.resumeThread = async () => {
    resumed = true;
    return f.child;
  };
  f.parent.settings = { permissionMode: "auto" };
  expect(
    await f.service.retryThread(f.parent.projectId, f.child.id).catch((error: unknown) => error),
  ).toMatchObject({ code: "FORBIDDEN" });
  expect(resumed).toBe(false);
  expect((await f.store.get(f.task.id))?.state).toBe("failed");
  await until(async () => Reflect.get(f.service, "active").size === 0);
});

test("retryThread final authorization preserves cancellation during provider preparation", async () => {
  const f = await providerRetryWait();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let submissions = 0;
  f.host.resumeThread = async (_project, _thread, authorize) => {
    entered.resolve();
    await release.promise;
    await authorize?.();
    submissions++;
    return f.child;
  };
  const retry = f.service
    .retryThread(f.parent.projectId, f.child.id)
    .catch((error: unknown) => error);
  await entered.promise;
  await f.service.cancel(f.scope, { task_id: f.task.id });
  release.resolve();
  expect(await retry).toMatchObject({ code: "FORBIDDEN" });
  expect(submissions).toBe(0);
  expect((await f.store.get(f.task.id))?.state).toBe("cancelled");
});

test("pauseForRestart waits for retryThread preparation and prevents its late submission", async () => {
  const f = await providerRetryWait();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let submissions = 0;
  f.host.resumeThread = async (_project, _thread, authorize) => {
    entered.resolve();
    await release.promise;
    await authorize?.();
    submissions++;
    return f.child;
  };
  const retry = f.service
    .retryThread(f.parent.projectId, f.child.id)
    .catch((error: unknown) => error);
  await entered.promise;
  let paused = false;
  const pausing = f.service.pauseForRestart().then(() => {
    paused = true;
  });
  await Promise.resolve();
  expect(paused).toBe(false);
  release.resolve();
  await pausing;
  expect(await retry).toBeUndefined();
  expect(submissions).toBe(0);
  expect((await f.store.get(f.task.id))?.state).toBe("running");
  expect(await f.service.retryThread(f.parent.projectId, f.child.id)).toBeUndefined();
});

test("retryThread does not resume queued, cancelled, unrelated, or closed tasks", async () => {
  const f = await fixture();
  const task = await durableTask(f);
  const child = childFor(f, task, "running");
  let resumes = 0;
  f.host.resumeThread = async () => {
    resumes++;
    return child;
  };
  expect(await f.service.retryThread(f.parent.projectId, child.id)).toBeUndefined();
  expect(await f.service.retryThread(randomUUID(), child.id)).toBeUndefined();
  await f.store.transition({ id: task.id, state: "running" });
  await f.store.transition({ id: task.id, state: "cancel_requested" });
  expect(await f.service.retryThread(f.parent.projectId, child.id)).toBeUndefined();
  await f.store.transition({ id: task.id, state: "cancelled" });
  expect(await f.service.retryThread(f.parent.projectId, child.id)).toBeUndefined();
  await f.service.close();
  expect(await f.service.retryThread(f.parent.projectId, child.id)).toBeUndefined();
  expect(resumes).toBe(0);
});

test("retryThread revalidates durable receiver grants before provider submission", async () => {
  const f = await fixture();
  const recipient = randomUUID();
  await f.store.setReceiver(f.parent.projectId, recipient, true);
  const task = await durableTask(f, {
    kind: "message",
    childThreadId: recipient,
    recipientGrant: f.store.receiverGrant(f.parent.projectId, recipient),
  });
  await f.store.transition({ id: task.id, state: "running" });
  const child = childFor(f, task, "running");
  let submissions = 0;
  let checkpointStops = 0;
  f.host.stopTaskTurn = async (_project, _thread, id) => {
    expect(id).toBe(task.id);
    checkpointStops++;
    return true;
  };
  f.host.resumeThread = async () => {
    submissions++;
    return child;
  };
  await f.store.setReceiver(f.parent.projectId, recipient, false);
  await f.store.setReceiver(f.parent.projectId, recipient, true);
  expect(
    await f.service.retryThread(f.parent.projectId, recipient).catch((error: unknown) => error),
  ).toMatchObject({ code: "FORBIDDEN" });
  await until(async () => (await f.store.get(task.id))?.state === "failed");
  await until(async () => checkpointStops === 1);
  expect(submissions).toBe(0);
});

test("retryThread never creates an absent child or appends an unsubmitted task prompt", async () => {
  const f = await fixture();
  const missing = await durableTask(f);
  await f.store.transition({ id: missing.id, state: "running" });
  let resumes = 0;
  f.host.resumeThread = async () => {
    resumes++;
    return f.parent;
  };
  expect(await f.service.retryThread(f.parent.projectId, missing.childThreadId)).toBeUndefined();
  const initial = await durableTask(f);
  await f.store.transition({ id: initial.id, state: "running" });
  await f.store.transition({ id: initial.id, state: "completed" });
  await f.store.delivered(initial.id);
  const followup = await durableTask(f, { kind: "followup", childThreadId: initial.childThreadId });
  await f.store.transition({ id: followup.id, state: "running" });
  childFor(f, initial, "completed");
  const send = spyOn(f.host, "sendMessage");
  cleanups.push(async () => send.mockRestore());
  expect(await f.service.retryThread(f.parent.projectId, followup.childThreadId)).toBeUndefined();
  expect(resumes).toBe(0);
  expect(f.launches()).toBe(0);
  expect(send).not.toHaveBeenCalled();
});

test("restart pause during result preparation retains delivery until the parent is restored", async () => {
  const f = await fixture();
  const task = await durableTask(f);
  await f.store.transition({ id: task.id, state: "running" });
  await f.store.transition({ id: task.id, state: "completed", summary: "Durable result" });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = f.host.readThread.bind(f.host);
  f.host.readThread = async (projectId, threadId) => {
    if (threadId === f.parent.id) {
      entered.resolve();
      await release.promise;
    }
    return read(projectId, threadId);
  };
  const reconciling = f.service.reconcile();
  await entered.promise;
  const pausing = f.service.pauseForRestart();
  f.parent.status = "stopped";
  release.resolve();
  await Promise.all([reconciling, pausing]);
  expect((await f.store.get(task.id))?.delivered).toBe(false);
  expect(f.parent.queuedMessages ?? []).toHaveLength(0);
  f.parent.status = "running";
  f.service.resumeAfterRestartFailure();
  await f.service.recover();
  expect(f.parent.queuedMessages).toHaveLength(1);
  expect(f.parent.queuedMessages![0].text).toContain("Durable result");
});

test("a bounded wait collects a recovered completion and acknowledges only after response delivery", async () => {
  const f = await fixture();
  const task = await durableTask(f);
  await f.store.transition({ id: task.id, state: "running" });
  const child = childFor(f, task, "completed");
  child.messages.push({ id: randomUUID(), role: "assistant", text: "Recovered findings" });
  const { service, store } = await reopenTasks(f);
  const subscribed = spyOn(store, "subscribe");
  const sends = spyOn(f.host, "sendMessage");
  cleanups.push(async () => {
    subscribed.mockRestore();
    sends.mockRestore();
  });
  const delivery = service.resultDelivery(f.scope);
  const waiting = service.read(f.scope, { task_ids: [task.id], wait_ms: 2000 }, delivery);
  await until(async () => subscribed.mock.calls.length === 1);
  await service.recover();
  const result = await waiting;
  expect(result.tasks[0]).toMatchObject({ state: "completed", summary: "Recovered findings" });
  expect((await store.get(task.id))?.delivered).toBe(false);
  await service.reconcile();
  expect(sends).not.toHaveBeenCalled();
  await delivery.settle(true);
  await service.recover();
  expect((await store.get(task.id))?.delivered).toBe(true);
  expect(sends).not.toHaveBeenCalled();
  expect(f.launches()).toBe(0);
});
