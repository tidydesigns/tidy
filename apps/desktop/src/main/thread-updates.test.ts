import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  summarizeThread,
  applyProjectEvent,
  applyThreadPatch,
  type ThreadPatch,
} from "../shared/thread-updates";
import type { Thread, ProjectSnapshot } from "../shared/contracts";

test("stream patches preserve old message identities, append once and ignore stale or foreign updates", () => {
  const first = { id: randomUUID(), role: "user" as const, text: "Earlier request" };
  const response = { id: randomUUID(), role: "assistant" as const, text: "Checking" };
  const previous: Thread = {
    id: randomUUID(),
    projectId: randomUUID(),
    revision: 2,
    title: "Work",
    harness: "codex",
    messages: [first, response],
    status: "running",
    designIds: [],
    updatedAt: new Date().toISOString(),
  };
  const nextResponse = { ...response, text: "Checking tests" };
  const metadata = {
    id: previous.id,
    projectId: previous.projectId,
    revision: previous.revision,
    title: previous.title,
    harness: previous.harness,
    status: previous.status,
    designIds: previous.designIds,
    updatedAt: previous.updatedAt,
  };
  const patch: ThreadPatch = {
    thread: { ...metadata, revision: 3 },
    summary: summarizeThread(previous),
    messages: [nextResponse],
    toolActivities: [],
    toolActivityIds: [],
  };
  const result = applyThreadPatch(previous, patch);
  expect(result.messages).toEqual([first, nextResponse]);
  expect(result.messages[0]).toBe(first);
  expect(applyThreadPatch(result, patch)).toBe(result);
  expect(
    applyThreadPatch(previous, { ...patch, thread: { ...patch.thread, projectId: randomUUID() } }),
  ).toBe(previous);
  const added = { id: randomUUID(), role: "assistant" as const, text: "Done" };
  const appended = applyThreadPatch(result, {
    ...patch,
    thread: { ...patch.thread, revision: 4 },
    messages: [added],
  });
  expect(appended.messages).toHaveLength(3);
  expect(appended.messages[2]).toBe(added);
  expect(
    applyThreadPatch(appended, { ...patch, thread: { ...patch.thread, revision: 5 }, messages: [] })
      .messages,
  ).toBe(appended.messages);
});

test("tool patches update rows and remove pruned logs without replacing unchanged rows", () => {
  const messageId = randomUUID();
  const makeTool = () => ({
    id: randomUUID(),
    afterMessageId: messageId,
    kind: "command" as const,
    title: "command",
    toolName: "Shell",
    status: "running" as const,
    startedAt: new Date().toISOString(),
  });
  const removed = makeTool(),
    kept = makeTool();
  const previous: Thread = {
    id: randomUUID(),
    projectId: randomUUID(),
    revision: 1,
    title: "Work",
    harness: "codex",
    messages: [{ id: messageId, role: "user", text: "Work" }],
    toolActivities: [removed, kept],
    status: "running",
    designIds: [],
    updatedAt: new Date().toISOString(),
  };
  const metadata = {
    id: previous.id,
    projectId: previous.projectId,
    revision: previous.revision,
    title: previous.title,
    harness: previous.harness,
    status: previous.status,
    designIds: previous.designIds,
    updatedAt: previous.updatedAt,
  };
  const patch: ThreadPatch = {
    thread: { ...metadata, revision: 2 },
    summary: summarizeThread(previous),
    messages: [],
    toolActivities: [],
    toolActivityIds: [kept.id],
  };
  const result = applyThreadPatch(previous, patch);
  expect(result.toolActivities).toEqual([kept]);
  expect(result.toolActivities![0]).toBe(kept);
  const unchanged = applyThreadPatch(result, {
    ...patch,
    thread: { ...patch.thread, revision: 3 },
  });
  expect(unchanged.toolActivities).toBe(result.toolActivities);
  expect(unchanged.messages).toBe(previous.messages);
});

test("project summaries keep early stream updates when bootstrap finishes and reject stale or foreign events", () => {
  const projectId = randomUUID();
  const old: Thread = {
    id: randomUUID(),
    projectId,
    revision: 1,
    title: "Review",
    harness: "codex",
    status: "running",
    designIds: [],
    messages: [],
    updatedAt: new Date().toISOString(),
  };
  const snapshot: ProjectSnapshot = {
    project: { id: projectId, name: "Project", path: "/project", openedAt: old.updatedAt },
    threads: [summarizeThread(old)],
    designs: [],
    folders: [],
  };
  const completed: Thread = {
    ...old,
    revision: 3,
    status: "completed",
    messages: [{ id: randomUUID(), role: "assistant", text: "Complete" }],
  };
  const ready = applyProjectEvent(snapshot, { type: "thread", thread: completed });
  expect(ready.threads[0].revision).toBe(3);
  expect(ready.threads[0].preview).toBe("Complete");
  expect(applyProjectEvent(ready, { type: "thread", thread: old })).toBe(ready);
  expect(
    applyProjectEvent(ready, { type: "thread", thread: { ...completed, projectId: randomUUID() } }),
  ).toBe(ready);
  const newThread = { ...old, id: randomUUID() };
  const added = applyProjectEvent(ready, { type: "thread", thread: newThread });
  expect(added.threads.map((thread) => thread.id)).toEqual([newThread.id, old.id]);
  const folder = { id: randomUUID(), name: "Explorations", updatedAt: old.updatedAt };
  const latest = applyProjectEvent(added, {
    type: "designs",
    projectId,
    folders: [folder],
    designs: [],
  });
  expect(latest.folders).toEqual([folder]);
  expect(latest.threads).toBe(added.threads);
});

test("thread summaries retain the execution project without copying conversation logs", () => {
  const executionProjectId = randomUUID();
  const summary = summarizeThread({
    id: randomUUID(),
    projectId: randomUUID(),
    executionProjectId,
    revision: 1,
    title: "Implement",
    harness: "codex",
    messages: [],
    status: "idle",
    designIds: [],
    updatedAt: new Date().toISOString(),
  });
  expect(summary.executionProjectId).toBe(executionProjectId);
  expect(summary).not.toHaveProperty("messages");
  expect(summary).not.toHaveProperty("sessionId");
});
