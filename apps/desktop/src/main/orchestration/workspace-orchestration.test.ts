import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ProjectStore } from "../workspace/project-store";
import { WorkspaceService } from "../workspace/workspace-service";
import type { startHarness } from "../harnesses/harnesses";
import type { AgentMcpConnection } from "../harnesses/session-types";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Workspace operation did not settle.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tidy-agent-workspace-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new ProjectStore(join(directory, "private"));
  await store.initialize();
  const root = join(directory, "project");
  await mkdir(root);
  const project = await store.register(root);
  const runs: { input: Parameters<typeof startHarness>[0]; complete(): void }[] = [];
  const service = new WorkspaceService(
    store,
    (input) => {
      const completion = Promise.withResolvers<void>();
      runs.push({ input, complete: completion.resolve });
      return { done: completion.promise, stop: completion.resolve, deliveryState: "accepted" };
    },
    async () => "/fixture/agent",
    async () => {},
  );
  cleanups.push(() => service.close());
  return { directory, store, service, project, runs };
}
async function call(connection: AgentMcpConnection, name: string, args: unknown) {
  const response = await fetch(connection.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (response.status !== 200) throw new Error(`Tool HTTP ${response.status}`);
  const { z } = await import("zod");
  const body = await response.text();
  const json =
    body.startsWith("event:") || body.startsWith("data:")
      ? JSON.parse(
          body
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6) ?? "null",
        )
      : JSON.parse(body);
  const result = z
    .object({
      result: z.object({
        isError: z.boolean().optional(),
        structuredContent: z.record(z.string(), z.unknown()).optional(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
      }),
    })
    .parse(json).result;
  if (result.isError) throw new Error(result.content[0]?.text ?? "Tool failed");
  return result.structuredContent ?? {};
}
test("renderer task views include queued assignments, durable turn links and private parent lineage", async () => {
  const f = await fixture();
  const parent = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    settings: { permissionMode: "read-only" },
    prompt: "Review with three agents",
    designIds: [],
  });
  const events: import("../../shared/contracts/desktop").DesktopEvent[] = [];
  const unsubscribe = f.service.subscribeRenderer((event) => events.push(event));
  cleanups.push(async () => {
    unsubscribe();
  });
  const tools = await f.runs[0].input.agentTools?.open();
  if (!tools) throw new Error("Missing tool connection.");
  cleanups.push(async () => tools.close());
  const first = await call(tools, "task_delegate", {
    request_id: randomUUID(),
    prompt: "Inspect design",
  });
  await call(tools, "task_delegate", { request_id: randomUUID(), prompt: "Inspect security" });
  await call(tools, "task_delegate", { request_id: randomUUID(), prompt: "Inspect performance" });
  await until(async () => f.runs.length === 3);
  const view = await f.service.readThreadTasks({ projectId: f.project.id, threadId: parent.id });
  expect(view.parent).toBeNull();
  expect(view.tasks).toHaveLength(3);
  expect(view.tasks.filter((task) => task.state === "queued")).toHaveLength(1);
  expect(view.tasks.every((task) => task.originatingMessageId === parent.messages[0].id)).toBe(
    true,
  );
  expect(
    events.some(
      (event) =>
        event.type === "thread-summary" &&
        event.thread.id === parent.id &&
        event.thread.taskSequence !== undefined,
    ),
  ).toBe(true);
  const child = await f.service.readThreadTasks({
    projectId: f.project.id,
    threadId: String(first.child_thread_id),
  });
  expect(child.parent).toEqual({ threadId: parent.id, title: parent.title });
  expect(
    (await f.service.readThread(f.project.id, String(first.child_thread_id))).parentThreadId,
  ).toBe(parent.id);
  const childEvents = events.filter(
    (event) => event.type !== "designs" && event.thread.id === first.child_thread_id,
  );
  expect(childEvents.length).toBeGreaterThan(0);
  for (const event of childEvents)
    if (event.type !== "designs") expect(event.thread.parentThreadId).toBe(parent.id);
  await expect(
    f.service.setThreadWorkPermission(f.project.id, String(first.child_thread_id), true),
  ).rejects.toThrow("Subagents");

  expect((await f.service.readThread(f.project.id, String(first.child_thread_id))).title).toBe(
    "Inspect design",
  );
  const serialized = JSON.stringify(view);
  expect(serialized).not.toContain("parentGrant");
  expect(serialized).not.toContain("permissionMode");
  expect(serialized).not.toContain("designIds");
  expect(
    await f.service
      .readThreadTasks({ projectId: randomUUID(), threadId: parent.id })
      .catch((error) => error),
  ).toBeInstanceOf(Error);
  f.runs[1].input.onUpdate({
    type: "message",
    id: "review-result",
    text: "Design review complete",
  });
  f.runs[1].complete();
  await until(async () =>
    (await f.service.readThreadTasks({ projectId: f.project.id, threadId: parent.id })).tasks.some(
      (task) => task.id === first.task_id && task.state === "completed",
    ),
  );
  expect(
    (await f.service.readThreadTasks({ projectId: f.project.id, threadId: parent.id })).tasks.find(
      (task) => task.id === first.task_id,
    )?.summary,
  ).toBe("Design review complete");
});

test("completed child events remain visible while task completion persistence retries", async () => {
  const f = await fixture();
  const parent = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    settings: { permissionMode: "read-only" },
    prompt: "Coordinate an inspection",
    designIds: [],
  });
  const tools = await f.runs[0].input.agentTools?.open();
  if (!tools) throw new Error("Missing agent tool connection.");
  cleanups.push(async () => tools.close());
  const task = await call(tools, "task_delegate", { request_id: randomUUID(), prompt: "Inspect" });
  await until(async () => f.runs.length === 2);
  const transition = f.service.tasks.store.transition.bind(f.service.tasks.store);
  const failures = spyOn(f.service.tasks.store, "transition").mockImplementation(async (input) => {
    if (input.id === task.task_id && input.state === "completed")
      throw new Error("Assignment completion could not be persisted.");
    return transition(input);
  });
  cleanups.push(async () => failures.mockRestore());
  const events: import("../../shared/contracts/desktop").DesktopEvent[] = [];
  const unsubscribe = f.service.subscribeRenderer((event) => events.push(event));
  cleanups.push(async () => {
    unsubscribe();
  });
  f.runs[1].complete();
  await until(async () =>
    events.some(
      (event) =>
        event.type === "thread" &&
        event.thread.id === task.child_thread_id &&
        event.thread.status === "completed",
    ),
  );
  expect((await f.service.tasks.store.get(String(task.task_id)))?.state).toBe("running");
  expect((await f.service.readThread(f.project.id, parent.id)).queuedMessages ?? []).toHaveLength(
    0,
  );
  failures.mockRestore();
  await f.service.tasks.deliver();
  expect((await f.service.tasks.store.get(String(task.task_id)))?.state).toBe("completed");
  expect(f.runs).toHaveLength(2);
});

test("a real workspace delegates, persists results, queues a parent continuation and revokes stopped tool access", async () => {
  const f = await fixture();
  const parent = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    settings: { permissionMode: "read-only" },
    prompt: "Coordinate an inspection",
    designIds: [],
  });
  const tools = await f.runs[0].input.agentTools?.open();
  if (!tools) throw new Error("Missing agent tool connection.");
  cleanups.push(async () => tools.close());
  const task = await call(tools, "task_delegate", {
    request_id: randomUUID(),
    prompt: "Inspect without editing",
  });
  expect(typeof task.task_id).toBe("string");
  await until(async () => f.runs.length === 2);
  expect(f.runs[1].input.settings?.permissionMode).toBe("read-only");
  f.runs[1].input.onUpdate({
    type: "message",
    id: "result",
    text: "Inspection complete. No changes.",
  });
  f.runs[1].complete();
  await until(async () => {
    const thread = await f.service.readThread(f.project.id, parent.id);
    return (thread.queuedMessages?.length ?? 0) === 1;
  });
  const result = await call(tools, "task_read", {});
  expect(JSON.stringify(result)).toContain("Inspection complete");
  f.runs[0].complete();
  await until(async () => f.runs.length === 3);
  expect(f.runs[2].input.prompt).toContain("worker-reported data");
  await f.service.stopThread(f.project.id, parent.id);
  expect(
    await call(tools, "thread_read", { thread_id: parent.id }).catch((error: unknown) => error),
  ).toBeInstanceOf(Error);
});

test("canvas edits through real MCP preserve exact versions and cannot access an unattached design", async () => {
  const f = await fixture();
  const design = await f.store.createDesign(f.project.id);
  const other = await f.store.createDesign(f.project.id);
  await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "Edit attached design",
    designIds: [design.id],
  });
  const tools = await f.runs[0].input.agentTools?.open();
  if (!tools) throw new Error("Missing tool connection.");
  cleanups.push(async () => tools.close());
  const info = await call(tools, "canvas_read", {
    design_id: design.id,
    node_ids: [design.document.nodes[0].id],
    detail: "full",
  });
  expect(info.version).toBe(design.version);
  const request = {
    design_id: design.id,
    expected_version: design.version,
    request_id: randomUUID(),
    operations: [
      { kind: "update", node_ids: [design.document.nodes[0].id], changes: { name: "Agent frame" } },
    ],
  };
  const edit = await call(tools, "canvas_edit", request);
  expect(edit.version).not.toBe(design.version);
  expect(await call(tools, "canvas_edit", request)).toEqual(edit);
  expect((await f.store.readDesign(f.project.id, design.id, false)).document.nodes[0].name).toBe(
    "Agent frame",
  );
  expect(
    await call(tools, "canvas_read", { design_id: other.id }).catch((error: unknown) => error),
  ).toBeInstanceOf(Error);
  expect(
    await call(tools, "canvas_edit", { ...request, request_id: randomUUID() }).catch(
      (error: unknown) => error,
    ),
  ).toBeInstanceOf(Error);
});

test("owned follow-ups share scheduler slots, preserve results and cancel through the original task", async () => {
  const f = await fixture();
  const parent = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    settings: { permissionMode: "read-only" },
    prompt: "Coordinate inspections",
    designIds: [],
  });
  const tools = await f.runs[0].input.agentTools?.open();
  if (!tools) throw new Error("Missing tool connection.");
  cleanups.push(async () => tools.close());
  const first = await call(tools, "task_delegate", { request_id: randomUUID(), prompt: "First" });
  await call(tools, "task_delegate", { request_id: randomUUID(), prompt: "Second" });
  await until(async () => f.runs.length === 3);
  const request = {
    thread_id: first.child_thread_id,
    request_id: randomUUID(),
    message: "Follow up",
  };
  const followup = await call(tools, "thread_send", request);
  expect(followup.task_id).not.toBe(first.task_id);
  expect((await call(tools, "thread_send", request)).task_id).toBe(followup.task_id);
  const later = await call(tools, "thread_send", {
    ...request,
    request_id: randomUUID(),
    message: "Later follow up",
  });
  expect(f.runs).toHaveLength(3);
  f.runs[1].input.onUpdate({ type: "message", id: "first-result", text: "Original result" });
  f.runs[1].complete();
  await until(async () => f.runs.length === 4);
  expect(f.runs[3].input.prompt).toContain("Follow up");
  const original = await f.service.tasks.store.get(String(first.task_id));
  expect(original?.state).toBe("completed");
  expect(original?.summary).toBe("Original result");
  const cancellation = await call(tools, "task_cancel", { task_id: first.task_id });
  expect(cancellation).toMatchObject({
    state: "completed",
    child_cancellation: { requested: true },
  });
  await until(
    async () => (await f.service.tasks.store.get(String(followup.task_id)))?.state === "cancelled",
  );
  expect((await f.service.tasks.store.get(String(later.task_id)))?.state).toBe("cancelled");
  expect((await f.service.tasks.store.get(String(first.task_id)))?.summary).toBe("Original result");
  expect(f.runs).toHaveLength(4);
  expect((await f.service.readThread(f.project.id, parent.id)).status).toBe("running");
});

test("completed children resume as independently reported runs in the same conversation", async () => {
  const f = await fixture();
  await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    settings: { permissionMode: "read-only" },
    prompt: "Coordinate",
    designIds: [],
  });
  const tools = await f.runs[0].input.agentTools?.open();
  if (!tools) throw new Error("Missing tool connection.");
  cleanups.push(async () => tools.close());
  const initial = await call(tools, "task_delegate", { request_id: randomUUID(), prompt: "First" });
  await until(async () => f.runs.length === 2);
  f.runs[1].input.onUpdate({ type: "message", id: "first", text: "Initial result" });
  f.runs[1].complete();
  await until(
    async () => (await f.service.tasks.store.get(String(initial.task_id)))?.state === "completed",
  );
  const next = await call(tools, "thread_send", {
    thread_id: initial.child_thread_id,
    request_id: randomUUID(),
    message: "Continue",
  });
  await until(async () => f.runs.length === 3);
  f.runs[2].input.onUpdate({ type: "message", id: "next", text: "Followup result" });
  f.runs[2].complete();
  await until(
    async () => (await f.service.tasks.store.get(String(next.task_id)))?.state === "completed",
  );
  expect((await f.service.tasks.store.get(String(next.task_id)))?.summary).toBe("Followup result");
  expect((await f.service.tasks.store.get(String(initial.task_id)))?.summary).toBe(
    "Initial result",
  );
  expect(next.child_thread_id).toBe(initial.child_thread_id);
  const child = await f.service.readThread(f.project.id, String(initial.child_thread_id));
  expect(
    child.messages.filter((message) => message.role === "assistant").map((message) => message.text),
  ).toEqual(["Initial result", "Followup result"]);
});

test("follow-ups respect both global and project concurrency across live workspaces", async () => {
  const f = await fixture();
  const root = join(f.project.path, "..", "other-project");
  await mkdir(root);
  const secondProject = await f.store.register(root);
  await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    settings: { permissionMode: "read-only" },
    prompt: "Parent one",
    designIds: [],
  });
  await f.service.startThread({
    projectId: secondProject.id,
    harness: "codex",
    settings: { permissionMode: "read-only" },
    prompt: "Parent two",
    designIds: [],
  });
  const tools = await f.runs[0].input.agentTools?.open();
  const otherTools = await f.runs[1].input.agentTools?.open();
  if (!tools || !otherTools) throw new Error("Missing tool connections.");
  cleanups.push(async () => {
    tools.close();
    otherTools.close();
  });
  const initial = await call(tools, "task_delegate", {
    request_id: randomUUID(),
    prompt: "Reusable child",
  });
  await until(async () => f.runs.length === 3);
  f.runs[2].complete();
  await until(
    async () => (await f.service.tasks.store.get(String(initial.task_id)))?.state === "completed",
  );
  const held: Record<string, unknown>[] = [];
  for (const connection of [tools, tools, otherTools, otherTools])
    held.push(
      await call(connection, "task_delegate", { request_id: randomUUID(), prompt: "Hold a slot" }),
    );
  await until(async () => f.runs.length === 7);
  const next = await call(tools, "thread_send", {
    thread_id: initial.child_thread_id,
    request_id: randomUUID(),
    message: "Continue in the same child",
  });
  expect(next.state).toBe("queued");
  expect(f.runs).toHaveLength(7);
  f.runs[5].complete();
  await until(
    async () => (await f.service.tasks.store.get(String(held[2].task_id)))?.state === "completed",
  );
  expect(f.runs).toHaveLength(7);
  f.runs[3].complete();
  await until(async () => f.runs.length === 8);
  expect(f.runs[7].input.prompt).toContain("Continue in the same child");
});

test("portable queue tampering cannot submit a native turn after restart and a permission upgrade", async () => {
  const f = await fixture();
  const parent = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    designIds: [],
    settings: { permissionMode: "read-only" },
    prompt: "Inspect",
  });
  const messageId = randomUUID();
  await f.service.sendMessage(
    {
      projectId: f.project.id,
      threadId: parent.id,
      delivery: "queue",
      messageId,
      text: "Bounded original",
    },
    {
      harness: "codex",
      permissionMode: "read-only",
      authorize: async () => {},
    },
  );
  await f.service.stopThread(f.project.id, parent.id);
  await until(
    async () => (await f.service.readThread(f.project.id, parent.id)).status === "stopped",
  );
  const thread = await f.store.readThread(f.project.id, parent.id);
  thread.settings = { permissionMode: "auto" };
  await f.store.writeThread(thread);
  await f.service.close();
  const path = await f.store.storagePath(f.project.id, "threads", parent.id);
  const portable = JSON.parse(await readFile(path, "utf8"));
  portable.queuedMessages[0].text = "Altered instruction";
  delete portable.queuedMessages[0].executionConstraint;
  await writeFile(path, JSON.stringify(portable));
  const reopened = new ProjectStore(join(f.directory, "private"));
  await reopened.initialize();
  let launches = 0;
  const service = new WorkspaceService(
    reopened,
    () => {
      launches++;
      throw new Error("Must not launch.");
    },
    async () => "/fixture/agent",
    async () => {},
  );
  cleanups.push(() => service.close());
  const result = await service.updateMessageQueue({
    projectId: f.project.id,
    threadId: parent.id,
    action: { kind: "steer", messageId },
  });
  expect(result.queueError).toContain("changed outside Tidy");
  expect(launches).toBe(0);
});

test("committed canvas edits acknowledge without waiting for unrelated project refreshes", async () => {
  const f = await fixture();
  const design = await f.store.createDesign(f.project.id);
  const parent = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    designIds: [design.id],
    prompt: "Edit attached canvas",
  });
  const tools = await f.runs[0].input.agentTools!.open();
  cleanups.push(async () => tools.close());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const refresh = spyOn(f.service, "refreshDesigns").mockImplementation(async () => {
    entered.resolve();
    await release.promise;
  });
  cleanups.push(async () => {
    release.resolve();
    refresh.mockRestore();
  });
  const editing = call(tools, "canvas_edit", {
    design_id: design.id,
    expected_version: design.version,
    request_id: randomUUID(),
    operations: [
      { kind: "update", node_ids: [design.document.nodes[0].id], changes: { name: "Committed" } },
    ],
  });
  await entered.promise;
  const result = await editing;
  expect(typeof result.version).toBe("string");
  expect((await f.store.readDesign(f.project.id, design.id, false)).document.nodes[0].name).toBe(
    "Committed",
  );
  expect(parent.id).toBeTruthy();
});

test("startup recovery does not block host readiness on a slow parent continuation", async () => {
  const f = await fixture();
  const parent = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    designIds: [],
    prompt: "Inspect",
  });
  const record = await f.service.tasks.store.create({
    projectId: f.project.id,
    parentThreadId: parent.id,
    childThreadId: randomUUID(),
    requestId: randomUUID(),
    prompt: "Recovered run",
    harness: "codex",
    settings: { permissionMode: "default" },
    designIds: [],
    depth: 1,
    parentGrant: { harness: "codex", permissionMode: "default" },
  });
  await f.service.tasks.store.transition({ id: record.id, state: "running" });
  await f.service.tasks.store.transition({
    id: record.id,
    state: "completed",
    summary: "Recovered result",
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const send = f.service.sendMessage.bind(f.service);
  const stalled = spyOn(f.service, "sendMessage").mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return send(...args);
  });
  cleanups.push(async () => {
    release.resolve();
    stalled.mockRestore();
  });
  const initialized = f.service.initializeOrchestration();
  await entered.promise;
  await initialized;
  expect((await f.service.tasks.store.get(record.id))?.delivered).toBe(false);
});

async function independentThreads() {
  const f = await fixture();
  const start = (prompt: string) =>
    f.service.startThread({
      projectId: f.project.id,
      harness: "codex",
      settings: { permissionMode: "read-only" },
      prompt,
      designIds: [],
    });
  const parent = await start("Coordinate existing work");
  const recipient = await start("Independent conversation");
  const tools = await f.runs[0].input.agentTools!.open();
  cleanups.push(async () => tools.close());
  return { ...f, parent, recipient, tools };
}

test("ordinary work waits for user turns, stays independent, and cancels only the requested assignment", async () => {
  const f = await independentThreads();
  const request = {
    thread_id: f.recipient.id,
    request_id: randomUUID(),
    message: "Review the existing plan",
  };
  await expect(call(f.tools, "thread_send", request)).rejects.toThrow("explicitly allow");
  await f.service.setThreadWorkPermission(f.project.id, f.recipient.id, true);
  const first = await call(f.tools, "thread_send", request);
  const retry = await call(f.tools, "thread_send", request);
  expect(retry.task_id).toBe(first.task_id);
  expect(first.kind).toBe("message");
  expect(first.state).toBe("queued");
  expect(f.runs).toHaveLength(2);
  const cancelled = await call(f.tools, "task_cancel", { task_id: first.task_id });
  expect(cancelled.state).toBe("cancelled");
  expect((await f.service.readThread(f.project.id, f.recipient.id)).status).toBe("running");
  const runningRequest = { ...request, request_id: randomUUID() };
  const running = await call(f.tools, "thread_send", runningRequest);
  f.runs[1].complete();
  await until(async () => f.runs.length === 3);
  const after = await f.service.readThread(f.project.id, f.recipient.id);
  expect(after.messages.at(-1)?.id).toBe(String(running.task_id));
  expect(after.parentThreadId).toBeUndefined();
  expect(after.messageSources?.[String(running.task_id)]).toEqual({ threadId: f.parent.id });
  const disk = await readFile(
    await f.store.storagePath(f.project.id, "threads", f.recipient.id),
    "utf8",
  );
  expect(disk).not.toContain("messageSources");
  const queued = await call(f.tools, "thread_send", { ...request, request_id: randomUUID() });
  await expect(
    f.service.cancelThreadTask(f.project.id, f.recipient.id, String(queued.task_id)),
  ).rejects.toThrow("not found");
  expect((await f.service.tasks.store.get(String(queued.task_id)))?.state).toBe("queued");
  await f.service.cancelThreadTask(f.project.id, f.parent.id, String(queued.task_id));
  expect((await f.service.tasks.store.get(String(queued.task_id)))?.state).toBe("cancelled");
  expect((await f.service.tasks.store.get(String(running.task_id)))?.state).toBe("running");
  expect((await f.service.readThread(f.project.id, f.recipient.id)).status).toBe("running");
  f.runs[2].input.onUpdate({
    type: "message",
    id: "ordinary-result",
    text: "Independent work complete",
  });
  await f.service.sendMessage({
    projectId: f.project.id,
    threadId: f.recipient.id,
    messageId: randomUUID(),
    text: "Keep the review focused",
    delivery: "steer",
  });
  f.runs[2].complete();
  await until(
    async () => (await f.service.tasks.store.get(String(running.task_id)))?.state === "completed",
  );
  expect(
    (await f.service.readThreadTasks({ projectId: f.project.id, threadId: f.recipient.id })).parent,
  ).toBeNull();
  expect(await f.service.tasks.store.forChild(f.project.id, f.recipient.id)).toBeUndefined();
  const summaries = f.service.withLiveThreads(
    f.project.id,
    (await f.store.snapshot(f.project.id)).threads,
  );
  expect(summaries.find((thread) => thread.id === f.recipient.id)?.parentThreadId).toBeUndefined();
  expect(summaries.find((thread) => thread.id === f.recipient.id)?.acceptsThreadWork).toBe(true);
  await expect(
    f.service.setThreadWorkPermission(randomUUID(), f.recipient.id, true),
  ).rejects.toThrow();
});

test("sender-scoped retry IDs produce distinct recipient turns and cancellation ownership", async () => {
  const f = await independentThreads();
  await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    settings: { permissionMode: "read-only" },
    prompt: "Coordinate another review",
    designIds: [],
  });
  const otherTools = await f.runs[2].input.agentTools?.open();
  if (!otherTools) throw new Error("Missing second sender tool connection.");
  cleanups.push(async () => otherTools.close());
  await f.service.setThreadWorkPermission(f.project.id, f.recipient.id, true);
  const request = {
    thread_id: f.recipient.id,
    request_id: randomUUID(),
    message: "Review the same plan",
  };
  const first = await call(f.tools, "thread_send", request);
  const second = await call(otherTools, "thread_send", request);
  expect(second.task_id).not.toBe(first.task_id);
  expect((await call(f.tools, "thread_send", request)).task_id).toBe(first.task_id);
  expect((await call(otherTools, "thread_send", request)).task_id).toBe(second.task_id);
  f.runs[1].complete();
  await until(async () => f.runs.length === 4);
  const firstTurn = await f.service.readThread(f.project.id, f.recipient.id);
  expect(firstTurn.messages.at(-1)?.id).toBe(String(first.task_id));
  f.runs[3].complete();
  await until(async () => f.runs.length === 5);
  const secondTurn = await f.service.readThread(f.project.id, f.recipient.id);
  expect(secondTurn.messages.at(-1)?.id).toBe(String(second.task_id));
  const firstCancellation = await call(f.tools, "task_cancel", { task_id: first.task_id });
  expect(firstCancellation.child_cancellation).toMatchObject({ requested: false, confirmed: true });
  expect((await f.service.tasks.store.get(String(second.task_id)))?.state).toBe("running");
  expect((await f.service.readThread(f.project.id, f.recipient.id)).status).toBe("running");
  const secondCancellation = await call(otherTools, "task_cancel", { task_id: second.task_id });
  expect(secondCancellation.child_cancellation).toMatchObject({ requested: true });
  await until(
    async () => (await f.service.tasks.store.get(String(second.task_id)))?.state === "cancelled",
  );
  expect(
    (await call(otherTools, "task_cancel", { task_id: second.task_id })).child_cancellation,
  ).toMatchObject({ confirmed: true });
  const recipient = await f.service.readThread(f.project.id, f.recipient.id);
  for (const task of [first, second])
    expect(recipient.messages.filter((message) => message.id === task.task_id)).toHaveLength(1);
  expect(recipient.messages.some((message) => message.id === request.request_id)).toBe(false);
  expect(f.runs).toHaveLength(5);
});

test("parent cancellation cannot stop a user turn replacing an incoming assignment during a stale read", async () => {
  const f = await independentThreads();
  await f.service.setThreadWorkPermission(f.project.id, f.recipient.id, true);
  const task = await call(f.tools, "thread_send", {
    thread_id: f.recipient.id,
    request_id: randomUUID(),
    message: "Review before the user continues",
  });
  f.runs[1].complete();
  await until(async () => f.runs.length === 3);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const readThread = f.service.readThread.bind(f.service);
  let capture = true;
  const stalled = spyOn(f.service, "readThread").mockImplementation(async (projectId, threadId) => {
    const thread = await readThread(projectId, threadId);
    if (capture && threadId === f.recipient.id) {
      capture = false;
      entered.resolve();
      await release.promise;
    }
    return thread;
  });
  cleanups.push(async () => {
    release.resolve();
    stalled.mockRestore();
  });
  const cancellation = f.service.tasks.cancelParent(f.project.id, f.parent.id);
  await entered.promise;
  f.runs[2].complete();
  await until(
    async () => (await f.service.tasks.store.get(String(task.task_id)))?.state === "cancelled",
  );
  const userMessageId = randomUUID();
  await f.service.sendMessage({
    projectId: f.project.id,
    threadId: f.recipient.id,
    messageId: userMessageId,
    text: "Continue my own work",
  });
  expect(f.runs).toHaveLength(4);
  expect(await f.service.stopTaskTurn(randomUUID(), f.recipient.id, userMessageId)).toBe(false);
  expect(await f.service.stopTaskTurn(f.project.id, f.recipient.id, String(task.task_id))).toBe(
    false,
  );
  release.resolve();
  await cancellation;
  const recipient = await f.service.readThread(f.project.id, f.recipient.id);
  expect(recipient.status).toBe("running");
  expect(recipient.activity).not.toBe("Stopping");
  expect(recipient.messages.at(-1)?.id).toBe(userMessageId);
});

for (const change of ["revoke", "done"] as const) {
  test(`queued ordinary work rechecks recipient ${change} before launch`, async () => {
    const f = await independentThreads();
    await f.service.setThreadWorkPermission(f.project.id, f.recipient.id, true);
    const task = await call(f.tools, "thread_send", {
      thread_id: f.recipient.id,
      request_id: randomUUID(),
      message: "Do later work",
    });
    if (change === "revoke") {
      await f.service.setThreadWorkPermission(f.project.id, f.recipient.id, false);
      await f.service.setThreadWorkPermission(f.project.id, f.recipient.id, true);
      f.runs[1].complete();
    } else await f.service.setThreadDone(f.project.id, f.recipient.id, true);
    await until(
      async () => (await f.service.tasks.store.get(String(task.task_id)))?.state === "failed",
    );
    expect(f.runs).toHaveLength(2);
    expect((await f.service.readThread(f.project.id, f.recipient.id)).messages).toHaveLength(1);
  });
}

test("subagents cannot send work to independent receivers or expand recipient permissions", async () => {
  const f = await independentThreads();
  await f.service.setThreadWorkPermission(f.project.id, f.recipient.id, true);
  const delegated = await call(f.tools, "task_delegate", {
    request_id: randomUUID(),
    prompt: "Bounded child review",
  });
  await until(async () => f.runs.length === 3);
  const childTools = await f.runs[2].input.agentTools!.open();
  cleanups.push(async () => childTools.close());
  await expect(
    call(childTools, "thread_send", {
      thread_id: f.recipient.id,
      request_id: randomUUID(),
      message: "Control unrelated work",
    }),
  ).rejects.toThrow("Subagents cannot");
  await expect(
    f.service.setThreadWorkPermission(f.project.id, String(delegated.child_thread_id), true),
  ).rejects.toThrow("Subagents");
  const context = await call(childTools, "thread_read", { thread_id: f.recipient.id });
  expect(context.parent_thread_id).toBeNull();
  expect(context.accepts_work).toBe(true);
});

test("owned follow-ups wait for a manually resumed child before launching", async () => {
  const f = await fixture();
  await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    settings: { permissionMode: "read-only" },
    prompt: "Coordinate",
    designIds: [],
  });
  const tools = await f.runs[0].input.agentTools!.open();
  cleanups.push(async () => tools.close());
  const initial = await call(tools, "task_delegate", {
    request_id: randomUUID(),
    prompt: "Review",
  });
  await until(async () => f.runs.length === 2);
  f.runs[1].complete();
  await until(
    async () => (await f.service.tasks.store.get(String(initial.task_id)))?.state === "completed",
  );
  await f.service.sendMessage({
    projectId: f.project.id,
    threadId: String(initial.child_thread_id),
    text: "Manual continuation",
  });
  expect(f.runs).toHaveLength(3);
  const followup = await call(tools, "thread_send", {
    thread_id: initial.child_thread_id,
    request_id: randomUUID(),
    message: "Scheduled follow-up",
  });
  expect((await f.service.tasks.store.get(String(followup.task_id)))?.state).toBe("queued");
  expect(f.runs).toHaveLength(3);
  f.runs[2].complete();
  await until(async () => f.runs.length === 4);
  f.runs[3].complete();
  await until(
    async () => (await f.service.tasks.store.get(String(followup.task_id)))?.state === "completed",
  );
});

for (const kind of ["child", "ordinary"] as const) {
  test(`updates do not resume ${kind} task execution outside its scheduler`, async () => {
    const f = await independentThreads();
    f.runs[0].input.onUpdate({ type: "session", id: randomUUID() });
    let target: string;
    if (kind === "child") {
      const task = await call(f.tools, "task_delegate", {
        request_id: randomUUID(),
        prompt: "Review",
      });
      target = String(task.child_thread_id);
    } else {
      f.runs[1].complete();
      await until(
        async () =>
          (await f.service.readThread(f.project.id, f.recipient.id)).status === "completed",
      );
      await f.service.setThreadWorkPermission(f.project.id, f.recipient.id, true);
      await call(f.tools, "thread_send", {
        thread_id: f.recipient.id,
        request_id: randomUUID(),
        message: "Review existing work",
      });
      target = f.recipient.id;
    }
    await until(async () => f.runs.length === 3);
    f.runs[2].input.onUpdate({ type: "session", id: randomUUID() });
    await f.service.prepareUpdate();
    const resumable = await f.store.updateResumes.list();
    expect(resumable.some((entry) => entry.threadId === f.parent.id)).toBe(true);
    expect(resumable.some((entry) => entry.threadId === target)).toBe(false);
  });
}

test("receiving permission publishes authoritative state to every connected view", async () => {
  const f = await independentThreads();
  const events: import("../../shared/contracts/desktop").Thread[] = [];
  const unsubscribe = f.service.subscribe((event) => {
    if (event.type === "thread" && event.thread.id === f.recipient.id) events.push(event.thread);
  });
  try {
    await f.service.setThreadWorkPermission(f.project.id, f.recipient.id, true);
    await f.service.setThreadWorkPermission(f.project.id, f.recipient.id, false);
    expect(events.map((thread) => thread.acceptsThreadWork)).toEqual([true, false]);
    expect((await f.service.readThread(f.project.id, f.recipient.id)).acceptsThreadWork).toBe(
      false,
    );
  } finally {
    unsubscribe();
  }
});
