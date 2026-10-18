import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyThreadPatch, type ThreadPatch } from "../shared/thread-updates";
import { summarizeThread, type Thread } from "../shared/contracts";

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
