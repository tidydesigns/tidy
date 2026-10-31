import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ProjectStore } from "../workspace/project-store";
import { liveThreadSchema, type Thread } from "../../shared/contracts/desktop";
import { CanvasService } from "./canvas-service";
import { TaskStore } from "./task-store";
import { TaskService, type TaskHost } from "./task-service";
import { orchestrationTools } from "./tools";
import type { AgentScope } from "./contracts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tidy-tool-contracts-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const documents = new ProjectStore(join(directory, "app"));
  await documents.initialize();
  const project = join(directory, "project");
  await mkdir(project);
  const snapshot = await documents.open(project);
  const parent: Thread = liveThreadSchema.parse({
    id: randomUUID(),
    projectId: snapshot.project.id,
    title: "Parent design",
    harness: "codex",
    settings: { permissionMode: "read-only" },
    designIds: [],
    messages: [],
    status: "completed",
    updatedAt: new Date().toISOString(),
  });
  await documents.writeThread(parent);
  let sends = 0;
  const host: TaskHost = {
    async assertCanStartTask() {
      return parent;
    },
    async assertProjectAccess(projectId) {
      if (projectId !== snapshot.project.id) throw new Error("Project access denied.");
    },
    readThread: (projectId, threadId) => documents.readThread(projectId, threadId),
    listThreads: (projectId) => documents.threadSummaries(projectId),
    async startThread() {
      throw new Error("No provider should launch in contract tests.");
    },
    async stopThread() {},
    async sendMessage(input) {
      sends++;
      const thread = await documents.readThread(input.projectId, input.threadId);
      thread.queuedMessages = [
        ...(thread.queuedMessages ?? []),
        { id: input.messageId ?? randomUUID(), text: input.text, attachments: [] },
      ];
      await documents.writeThread(thread);
      return thread;
    },
  };
  const store = new TaskStore(join(directory, "tasks"));
  await store.initialize();
  const tasks = new TaskService(store, host);
  cleanups.push(() => tasks.close());
  const canvas = new CanvasService({
    store: documents,
    receipts: {
      read: (key) => store.readReceipt(key),
      write: (key, value) => store.writeReceipt(key, value),
    },
    authorize: async () => {},
    onChange: async () => {},
  });
  cleanups.push(() => canvas.close());
  const scope: AgentScope = {
    projectId: parent.projectId,
    threadId: parent.id,
    designIds: [],
    writable: false,
    signal: new AbortController().signal,
  };
  const tools = orchestrationTools({ scope, tasks, canvas, host });
  const call = (name: string, input: unknown) => {
    const tool = tools.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    return tool.invoke(input);
  };
  async function addThread(overrides: Partial<Thread> = {}) {
    const thread: Thread = { ...parent, id: randomUUID(), title: "Related design", ...overrides };
    await documents.writeThread(thread);
    return thread;
  }
  return { store, documents, parent, scope, tools, call, addThread, sends: () => sends };
}

test("the initial catalog has ten typed tools within a fixed schema budget", async () => {
  const { tools } = await fixture();
  expect(tools.map((tool) => tool.name)).toEqual([
    "tidy_context",
    "threads_find",
    "thread_read",
    "thread_send",
    "task_delegate",
    "task_read",
    "task_cancel",
    "canvas_read",
    "canvas_edit",
    "canvas_render",
  ]);
  const catalog = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema),
    outputSchema: tool.outputSchema && z.toJSONSchema(tool.outputSchema),
  }));
  expect(Buffer.byteLength(JSON.stringify(catalog))).toBeLessThan(24 * 1024);
  for (const tool of tools) {
    expect(tool.inputSchema).toBeInstanceOf(z.ZodObject);
    expect(tool.outputSchema).toBeDefined();
    expect(tool.outputSchema?.safeParse({}).success).toBe(false);
  }
});

test("thread reads cap bytes and messages, preserve a cursor and never include native state", async () => {
  const { parent, addThread, call } = await fixture();
  const thread = await addThread({
    sessionId: "native-private",
    messages: Array.from({ length: 40 }, () => ({
      id: randomUUID(),
      role: "assistant",
      text: "x".repeat(32_000),
    })),
  });
  const result = z
    .object({
      messages: z.array(z.object({ text: z.string(), truncated: z.boolean() })),
      next_after: z.number(),
      total_messages: z.number(),
    })
    .parse(await call("thread_read", { thread_id: thread.id, limit: 100 }));
  expect(result.messages.length).toBeGreaterThan(0);
  expect(result.messages.length).toBeLessThan(40);
  expect(result.next_after).toBe(0);
  expect(result.messages).toHaveLength(1);
  expect(result.total_messages).toBe(40);
  expect(
    result.messages.every((message) => message.text.length === 16_000 && message.truncated),
  ).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(129 * 1024);
  expect(JSON.stringify(result)).not.toContain("native-private");
  await expect(call("thread_read", { thread_id: parent.id, limit: 101 })).rejects.toThrow();
});

test("thread search cursors survive streaming updates and reject changed result membership", async () => {
  const { call, addThread, documents } = await fixture();
  const thread = await addThread();
  await addThread();
  const page = z
    .object({ next_cursor: z.string() })
    .parse(await call("threads_find", { query: "design", limit: 1 }));
  await expect(call("threads_find", { cursor: "not-json" })).rejects.toMatchObject({
    code: "INVALID_CURSOR",
  });
  await expect(
    call("threads_find", { query: "other", cursor: page.next_cursor }),
  ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  thread.revision++;
  await documents.writeThread(thread);
  expect(await call("threads_find", { query: "design", cursor: page.next_cursor })).toHaveProperty(
    "threads",
  );
  thread.title = "Unrelated";
  await documents.writeThread(thread);
  await expect(
    call("threads_find", { query: "design", cursor: page.next_cursor }),
  ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
});

test("follow-ups reject unrelated threads and child permission elevation", async () => {
  const { store, parent, call, addThread, sends } = await fixture();
  const child = await addThread({ settings: { permissionMode: "auto" } });
  expect(
    await call("thread_send", {
      thread_id: child.id,
      request_id: randomUUID(),
      message: "Follow up",
    }).catch((error: unknown) => error),
  ).toMatchObject({ code: "FORBIDDEN" });
  await store.create({
    projectId: parent.projectId,
    parentThreadId: parent.id,
    childThreadId: child.id,
    requestId: randomUUID(),
    prompt: "Private worker brief",
    harness: "codex",
    settings: { permissionMode: "read-only" },
    designIds: [],
    depth: 1,
  });
  expect(
    await call("thread_send", {
      thread_id: child.id,
      request_id: randomUUID(),
      message: "Follow up",
    }).catch((error: unknown) => error),
  ).toMatchObject({ code: "FORBIDDEN" });
  expect(sends()).toBe(0);
});

test("task reads expose owned results without private prompts or configuration", async () => {
  const { store, parent, call } = await fixture();
  await store.create({
    projectId: parent.projectId,
    parentThreadId: parent.id,
    childThreadId: randomUUID(),
    requestId: randomUUID(),
    prompt: "Private worker brief",
    harness: "codex",
    settings: { model: "private-model" },
    designIds: [],
    depth: 1,
  });
  await store.create({
    projectId: parent.projectId,
    parentThreadId: randomUUID(),
    childThreadId: randomUUID(),
    requestId: randomUUID(),
    prompt: "Other thread brief",
    harness: "codex",
    settings: {},
    designIds: [],
    depth: 1,
  });
  const result = z
    .object({ tasks: z.array(z.object({ task_id: z.string() })) })
    .passthrough()
    .parse(await call("task_read", {}));
  expect(result.tasks).toHaveLength(1);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("Private worker brief");
  expect(serialized).not.toContain("Other thread brief");
  expect(serialized).not.toContain("private-model");
});

test("thread message chunk cursors preserve long Unicode content, middle blockers and exact suffixes", async () => {
  const { call, addThread } = await fixture();
  const texts = [
    "Short introduction",
    "🧪\u0000".repeat(7000) +
      "MIDDLE BLOCKER: missing credential" +
      "長文".repeat(9000) +
      "EXACT SUFFIX: stop here.",
    "Final short message",
    "",
  ];
  const thread = await addThread({
    messages: texts.map((text) => ({ id: randomUUID(), role: "assistant", text })),
  });
  const chunks = new Map<string, string>();
  let after = 0;
  let textOffset = 0;
  let pages = 0;
  while (true) {
    const result = z
      .object({
        messages: z.array(
          z.object({
            id: z.string(),
            text: z.string(),
            text_offset: z.number(),
            text_length: z.number(),
          }),
        ),
        next_after: z.number().nullable(),
        next_text_offset: z.number().nullable(),
      })
      .parse(
        await call("thread_read", {
          thread_id: thread.id,
          after,
          text_offset: textOffset,
          text_limit: 7999,
          limit: 100,
        }),
      );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
    expect(result.messages.length).toBeGreaterThan(0);
    for (const message of result.messages) {
      const previous = chunks.get(message.id) ?? "";
      expect(message.text_offset).toBe(previous.length);
      chunks.set(message.id, previous + message.text);
    }
    pages++;
    if (result.next_after === null) {
      expect(result.next_text_offset).toBeNull();
      break;
    }
    if (result.next_text_offset === null) throw new Error("Missing continuation text offset.");
    expect(result.next_after > after || result.next_text_offset > textOffset).toBe(true);
    after = result.next_after;
    textOffset = result.next_text_offset;
  }
  expect(pages).toBeGreaterThan(2);
  expect(thread.messages.map((message) => chunks.get(message.id))).toEqual(texts);
  for (const cursor of [
    { after: 5 },
    { after: 4, text_offset: 1 },
    { after: 0, text_offset: texts[0].length },
    { after: 0, text_offset: 999_999 },
  ]) {
    expect(
      await call("thread_read", { thread_id: thread.id, ...cursor }).catch(
        (error: unknown) => error,
      ),
    ).toMatchObject({ code: "INVALID_CURSOR" });
  }
  const short = z
    .object({
      messages: z.array(z.object({ text: z.string() })),
      next_after: z.number(),
      next_text_offset: z.number(),
    })
    .parse(await call("thread_read", { thread_id: thread.id, limit: 1 }));
  expect(short.messages.map((message) => message.text)).toEqual([texts[0]]);
  expect(short.next_after).toBe(1);
  expect(short.next_text_offset).toBe(0);
});

test("thread reads byte-bound pages of escaped text without losing whole messages", async () => {
  const { call, addThread } = await fixture();
  const thread = await addThread({
    messages: Array.from({ length: 4 }, () => ({
      id: randomUUID(),
      role: "assistant",
      text: "\u0000".repeat(16_000),
    })),
  });
  let after = 0;
  const ids: string[] = [];
  while (true) {
    const result = z
      .object({
        messages: z.array(z.object({ id: z.string(), text: z.string() })),
        next_after: z.number().nullable(),
        next_text_offset: z.number().nullable(),
      })
      .passthrough()
      .parse(await call("thread_read", { thread_id: thread.id, after, limit: 100 }));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
    expect(result.messages).toHaveLength(1);
    ids.push(...result.messages.map((message) => message.id));
    if (result.next_after === null) break;
    expect(result.next_text_offset).toBe(0);
    after = result.next_after;
  }
  expect(ids).toEqual(thread.messages.map((message) => message.id));
});

test("thread context reports configured and provider-reported settings without inventing defaults", async () => {
  const f = await fixture();
  f.parent.settings = { permissionMode: "read-only", model: "requested-model", effort: "high" };
  f.parent.actualModel = "reported-model";
  await f.documents.writeThread(f.parent);
  expect(await f.call("tidy_context", {})).toMatchObject({
    current_thread: {
      harness: "codex",
      model: "reported-model",
      model_source: "provider_reported",
      requested_model: "requested-model",
      reasoning_effort: "high",
      reasoning_effort_source: "thread_setting",
      permission_mode: "read-only",
      execution_project_id: f.parent.projectId,
      parent_thread_id: null,
      originating_task_id: null,
    },
  });
  f.parent.settings = { permissionMode: "read-only" };
  delete f.parent.actualModel;
  await f.documents.writeThread(f.parent);
  expect(await f.call("tidy_context", {})).toMatchObject({
    current_thread: {
      model: null,
      model_source: "provider_default_unreported",
      reasoning_effort: null,
      reasoning_effort_source: "provider_default_unreported",
    },
  });
});
