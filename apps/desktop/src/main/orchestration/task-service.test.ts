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
      if (!thread || thread.projectId !== projectId) throw new Error("Thread missing.");
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
        (message) => message.id !== input.messageId || message.text !== input.text,
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
  return { store, service, scope, parent, host, threads, controller, launches: () => launches };
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

test("delegation preserves effort only for an unchanged harness and model", async () => {
  const f = await fixture();
  f.parent.settings = { permissionMode: "auto", model: "original-model", effort: "xhigh" };
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
