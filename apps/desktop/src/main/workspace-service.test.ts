import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";
import type { startHarness, HarnessUpdate } from "./harnesses";
import type { Thread } from "../shared/contracts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tidy-workspace-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new ProjectStore(join(directory, "app"));
  await store.initialize();
  const root = join(directory, "project");
  await mkdir(root);
  const snapshot = await store.open(root);
  const runs: Array<{
    input: Parameters<typeof startHarness>[0];
    complete: () => void;
    stopped: boolean;
  }> = [];
  const service = new WorkspaceService(
    store,
    (input) => {
      let complete!: () => void;
      const done = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const run = { input, complete, stopped: false };
      runs.push(run);
      return {
        done,
        stop() {
          run.stopped = true;
          complete();
        },
      };
    },
    async () => "/fixture/harness",
    async () => {},
  );
  cleanups.push(() => service.close());
  return { directory, store, service, project: snapshot.project, runs };
}
function finished(service: WorkspaceService, threadId: string) {
  return new Promise<Thread>((resolve) => {
    const unsubscribe = service.subscribe((event) => {
      if (
        event.type === "thread" &&
        event.thread.id === threadId &&
        event.thread.status !== "running"
      ) {
        unsubscribe();
        resolve(event.thread);
      }
    });
  });
}

test("design references reach the harness and follow-up messages resume the same session", async () => {
  const { service, store, project, runs } = await fixture();
  const design = await store.createDesign(project.id);
  const thread = await service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "Implement this design",
    designIds: [design.id],
  });
  expect(runs[0].input.cwd).toBe(project.path);
  expect(runs[0].input.prompt).toContain(design.path);
  const sessionId = randomUUID();
  const updates: HarnessUpdate[] = [
    { type: "session", id: sessionId },
    { type: "message", id: "native-message", text: "Hello ", append: true },
    { type: "message", id: "native-message", text: "project", append: true },
    { type: "message", id: "native-message", text: "Hello project" },
  ];
  updates.forEach(runs[0].input.onUpdate);
  const completion = finished(service, thread.id);
  runs[0].complete();
  const completed = await completion;
  expect(completed.messages.map((message) => message.text)).toEqual([
    "Implement this design",
    "Hello project",
  ]);
  await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "Now add tests" });
  expect(runs[1].input.sessionId).toBe(sessionId);
  expect((await service.readThread(project.id, thread.id)).messages[2].text).toBe("Now add tests");
});

test("projects remain isolated, concurrent turns are rejected and stopping fences late output", async () => {
  const { directory, service, store, project, runs } = await fixture();
  const root = join(directory, "second");
  await mkdir(root);
  const other = (await store.open(root)).project;
  const first = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "First",
    designIds: [],
  });
  const second = await service.startThread({
    projectId: other.id,
    harness: "claude",
    prompt: "Second",
    designIds: [],
  });
  await expect(service.readThread(other.id, first.id)).rejects.toThrow("another project");
  await expect(service.stopThread(other.id, first.id)).rejects.toThrow("another project");
  await expect(
    service.sendMessage({ projectId: project.id, threadId: first.id, text: "Duplicate" }),
  ).rejects.toThrow("already running");
  const completion = finished(service, first.id);
  await service.stopThread(project.id, first.id);
  runs[0].input.onUpdate({ type: "message", id: "late", text: "should not appear" });
  const stopped = await completion;
  expect(stopped.status).toBe("stopped");
  expect(stopped.messages.some((message) => message.text === "should not appear")).toBe(false);
  expect((await service.readThread(other.id, second.id)).status).toBe("running");
  expect(runs[1].stopped).toBe(false);
});

test("closing during harness discovery does not launch a process after shutdown", async () => {
  const { store, project } = await fixture();
  let release!: (path: string) => void;
  let locating!: () => void;
  const located = new Promise<void>((resolve) => {
    locating = resolve;
  });
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  let launched = false;
  const service = new WorkspaceService(
    store,
    () => {
      launched = true;
      throw new Error("Must not launch");
    },
    () => {
      locating();
      return gate;
    },
  );
  const request = service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Work",
    designIds: [],
  });
  await located;
  await service.close();
  release("/fixture/harness");
  await expect(request).rejects.toThrow("closing");
  expect(launched).toBe(false);
});

test("stopping during the first disk checkpoint prevents process launch", async () => {
  const { store, service, project, runs } = await fixture();
  const original = store.writeThread.bind(store);
  let release!: () => void;
  let admitted!: (thread: Thread) => void;
  const admission = new Promise<Thread>((resolve) => {
    admitted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  store.writeThread = async (value) => {
    if (value.status === "running") {
      admitted(value);
      await gate;
    }
    return original(value);
  };
  const request = service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Work",
    designIds: [],
  });
  const thread = await admission;
  await service.stopThread(project.id, thread.id);
  release();
  expect((await request).status).toBe("stopped");
  expect(runs.length).toBe(0);
  expect((await store.readThread(project.id, thread.id)).status).toBe("stopped");
});

test("Done is an explicit persisted thread state, independent of a finished harness turn", async () => {
  const { directory, service, store, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Finish the design",
    designIds: [],
  });
  const sessionId = randomUUID();
  runs[0].input.onUpdate({ type: "session", id: sessionId });
  await expect(service.setThreadDone(project.id, thread.id, true)).rejects.toThrow("finish");
  const completion = finished(service, thread.id);
  runs[0].complete();
  const completed = await completion;
  expect(completed.status).toBe("completed");
  expect(completed.doneAt).toBeUndefined();
  const marked = await service.setThreadDone(project.id, thread.id, true);
  expect(marked.doneAt).toBeDefined();
  expect(marked.updatedAt).toBe(completed.updatedAt);
  expect(marked.revision).toBe(completed.revision + 1);
  expect((await service.setThreadDone(project.id, thread.id, true)).revision).toBe(marked.revision);
  const reopenedStore = new ProjectStore(join(directory, "app"));
  await reopenedStore.initialize();
  expect((await reopenedStore.snapshot(project.id)).threads[0].doneAt).toBe(marked.doneAt);
  await expect(
    service.sendMessage({ projectId: project.id, threadId: thread.id, text: "Continue" }),
  ).rejects.toThrow("Reopen");
  expect(runs).toHaveLength(1);
  await service.setThreadDone(project.id, thread.id, false);
  expect((await store.readThread(project.id, thread.id)).doneAt).toBeUndefined();
  await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "Continue" });
  expect(runs[1].input.sessionId).toBe(sessionId);
});

test("thread completion rejects project mismatches and never publishes a failed disk write", async () => {
  const { directory, service, store, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "One task",
    designIds: [],
  });
  const completion = finished(service, thread.id);
  runs[0].complete();
  await completion;
  const otherRoot = join(directory, "other");
  await mkdir(otherRoot);
  const other = (await store.open(otherRoot)).project;
  await expect(service.setThreadDone(other.id, thread.id, true)).rejects.toThrow();
  const write = store.writeThread.bind(store);
  store.writeThread = async () => {
    throw new Error("Disk full");
  };
  const events: unknown[] = [];
  const unsubscribe = service.subscribe((event) => events.push(event));
  await expect(service.setThreadDone(project.id, thread.id, true)).rejects.toThrow("Disk full");
  expect(events).toHaveLength(0);
  expect((await store.readThread(project.id, thread.id)).doneAt).toBeUndefined();
  store.writeThread = write;
  unsubscribe();
});

test("model settings persist and resume the same session; usage respects per-turn and cumulative reports", async () => {
  const { service, store, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "First",
    designIds: [],
    settings: { model: "fixture-codex", effort: "high" },
  });
  expect(runs[0].input.settings).toEqual({ model: "fixture-codex", effort: "high" });
  const sessionId = randomUUID();
  runs[0].input.onUpdate({ type: "session", id: sessionId });
  runs[0].input.onUpdate({
    type: "usage",
    usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 },
    cumulative: false,
  });
  const completion = finished(service, thread.id);
  runs[0].complete();
  await completion;
  await service.setThreadSettings(project.id, thread.id, {
    model: "another-model",
    effort: "medium",
  });
  expect((await store.readThread(project.id, thread.id)).settings?.model).toBe("another-model");
  await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "Second" });
  expect(runs[1].input.sessionId).toBe(sessionId);
  expect(runs[1].input.settings?.effort).toBe("medium");
  await expect(
    service.setThreadSettings(project.id, thread.id, { model: "third-model" }),
  ).rejects.toThrow("finish");
  runs[1].input.onUpdate({
    type: "usage",
    usage: { inputTokens: 150, cachedInputTokens: 30, outputTokens: 15 },
    cumulative: false,
  });
  runs[1].input.onUpdate({
    type: "usage",
    usage: { inputTokens: 150, cachedInputTokens: 30, outputTokens: 15 },
    cumulative: false,
  });
  expect((await service.readThread(project.id, thread.id)).usage?.inputTokens).toBe(250);
  runs[1].input.onUpdate({
    type: "usage",
    usage: { inputTokens: 300, cachedInputTokens: 50, outputTokens: 30, costUSD: 0.1 },
    cumulative: true,
  });
  runs[1].input.onUpdate({
    type: "usage",
    usage: { inputTokens: 300, cachedInputTokens: 50, outputTokens: 30, costUSD: 0.1 },
    cumulative: true,
  });
  expect((await service.readThread(project.id, thread.id)).usage).toEqual({
    inputTokens: 300,
    cachedInputTokens: 50,
    outputTokens: 30,
    costUSD: 0.1,
  });
});
