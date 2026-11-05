import { expect, test } from "bun:test";
import { desktopEventSchema, type Thread } from "../../../../shared/contracts/desktop";
import type { ToolActivity } from "../../../../shared/contracts/tool-activity";
import { applyThreadPatch, summarizeThread } from "../../../../shared/models/thread-updates";
import {
  groupMessageActivity,
  streamingAssistantMessage,
  groupConversationTurns,
  splitTurnResponse,
} from "./turn-activity";

const time = "2026-10-28T09:00:00.000Z";
const tool = (id: string, afterMessageId: string): ToolActivity => ({
  id,
  afterMessageId,
  kind: "command",
  toolName: "Shell",
  title: "bun test",
  status: "completed",
  startedAt: time,
});

test("validated wire patches retain unchanged tools and invalidate changed output", () => {
  const userId = crypto.randomUUID();
  const initial: Thread = {
    id: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    revision: 1,
    title: "Inspect",
    harness: "codex",
    status: "running",
    updatedAt: time,
    designIds: [],
    messages: [
      { id: userId, role: "user", text: "Inspect", turn: { startedAt: time } },
      { id: crypto.randomUUID(), role: "assistant", text: "Checking" },
    ],
    toolActivities: [tool(crypto.randomUUID(), userId)],
  };
  const original = groupMessageActivity(initial);
  const { messages, toolActivities = [], ...metadata } = initial;
  function receive(revision: number, changed: ToolActivity[]) {
    const event = desktopEventSchema.parse({
      type: "thread-patch",
      thread: { ...metadata, revision },
      summary: { ...summarizeThread(initial), revision },
      messages: [{ ...messages[1], text: "Checking the tests" }],
      toolActivities: changed,
      toolActivityIds: toolActivities.map((item) => item.id),
    });
    if (event.type !== "thread-patch") throw new Error("Expected a thread patch.");
    return event;
  }
  const streamed = applyThreadPatch(initial, receive(2, []));
  const retained = groupMessageActivity(streamed, original);
  expect(retained.get(userId)).toBe(original.get(userId));
  const updated = applyThreadPatch(
    streamed,
    receive(3, [{ ...toolActivities[0], output: "Passed" }]),
  );
  const changed = groupMessageActivity(updated, retained);
  expect(changed.get(userId)).not.toBe(retained.get(userId));
  expect(changed.get(userId)?.[0].output).toBe("Passed");
  expect(original.get(userId)?.[0].output).toBeUndefined();
});

test("inline activity preserves exact message anchors and stable groups during streaming", () => {
  const messages: Thread["messages"] = [
    { id: "prompt", role: "user", text: "Inspect", turn: { startedAt: time } },
    { id: "update", role: "assistant", text: "Checking" },
    { id: "steer", role: "user", text: "Include tests" },
    { id: "final", role: "assistant", text: "Done" },
  ];
  const activities = [
    tool("one", "prompt"),
    tool("two", "update"),
    tool("three", "steer"),
    tool("old", "missing"),
  ];
  const groups = groupMessageActivity({ messages, toolActivities: activities });
  expect(groups.size).toBe(3);
  expect(groups.get("update")).toEqual([activities[1]]);
  expect(groups.get("steer")).toEqual([activities[2]]);
  const retained = groupMessageActivity(
    {
      messages: [...messages.slice(0, -1), { ...messages[3], text: "Done testing" }],
      toolActivities: activities,
    },
    groups,
  );
  expect(retained.get("update")).toBe(groups.get("update"));
});

test("turn groups retain steering and separate later turns", () => {
  const messages: Thread["messages"] = [
    { id: "prompt", role: "user", text: "Inspect", turn: { startedAt: time } },
    { id: "final", role: "assistant", text: "Done" },
    { id: "steer", role: "user", text: "Include tests" },
    { id: "next", role: "user", text: "Continue", turn: { startedAt: time } },
  ];
  expect(groupConversationTurns(messages)).toEqual([messages.slice(0, 3), [messages[3]]]);
  expect(groupConversationTurns([])).toEqual([]);
  const legacy = messages.map((message) => ({ ...message, turn: undefined }));
  expect(groupConversationTurns(legacy)).toEqual([legacy.slice(0, 2), [legacy[2]], [legacy[3]]]);
  expect(groupConversationTurns([messages[1]])).toEqual([[messages[1]]]);
});

test("inline groups reconcile reordered tools, changed anchors and pruned history", () => {
  const messages: Thread["messages"] = [
    { id: "first", role: "user", text: "Inspect" },
    { id: "next", role: "assistant", text: "Checking" },
  ];
  const activities = [tool("one", "first"), tool("two", "first"), tool("three", "next")];
  const original = groupMessageActivity({ messages, toolActivities: activities });
  const reordered = groupMessageActivity(
    { messages, toolActivities: [activities[1], activities[0], activities[2]] },
    original,
  );
  expect(reordered.get("first")).toEqual([activities[1], activities[0]]);
  expect(reordered.get("next")).toBe(original.get("next"));
  const moved = { ...activities[0], afterMessageId: "next" };
  const updated = groupMessageActivity(
    { messages, toolActivities: [moved, activities[2]] },
    reordered,
  );
  expect(updated.has("first")).toBe(false);
  expect(updated.get("next")).toEqual([moved, activities[2]]);
  expect(groupMessageActivity({ messages: [], toolActivities: activities }, updated).size).toBe(0);
});

test("streaming stays in its active turn across steering and excludes older replies", () => {
  const messages: Thread["messages"] = [
    { id: "first", role: "user", text: "Inspect", turn: { startedAt: time } },
    { id: "reply", role: "assistant", text: "Checking" },
    { id: "steer", role: "user", text: "Include tests" },
    { id: "next", role: "user", text: "Continue", turn: { startedAt: time } },
  ];
  expect(streamingAssistantMessage({ messages: messages.slice(0, -1), turnId: "first" })).toBe(
    "reply",
  );
  expect(streamingAssistantMessage({ messages, turnId: "next" })).toBeUndefined();
  expect(streamingAssistantMessage({ messages: [], turnId: "first" })).toBeUndefined();
});

test("completed work separates the final response without discarding intermediate content", () => {
  const messages: Thread["messages"] = [
    { id: "update", role: "assistant", text: "Checking" },
    { id: "steer", role: "user", text: "Check the tests" },
    { id: "final", role: "assistant", text: "Done", attachments: [] },
  ];
  expect(splitTurnResponse(messages)).toEqual({
    history: messages.slice(0, 2),
    response: messages[2],
    trailing: [],
  });
  expect(splitTurnResponse([messages[2]])).toEqual({
    history: [],
    response: messages[2],
    trailing: [],
  });
  expect(splitTurnResponse(messages.slice(0, 2))).toEqual({
    history: [],
    response: messages[0],
    trailing: [messages[1]],
  });
  expect(splitTurnResponse([messages[1]])).toEqual({
    history: [messages[1]],
    response: undefined,
    trailing: [],
  });
  expect(splitTurnResponse([])).toEqual({ history: [], response: undefined, trailing: [] });
});
