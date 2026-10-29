import { expect, test } from "bun:test";
import { desktopEventSchema, type Thread } from "../../../../shared/contracts/desktop";
import type { ToolActivity } from "../../../../shared/contracts/tool-activity";
import { applyThreadPatch, summarizeThread } from "../../../../shared/models/thread-updates";
import { groupTurnActivity } from "./turn-activity";

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

test("commands stay with their originating turn across replies and steering messages", () => {
  const messages: Thread["messages"] = [
    { id: "first", role: "user", text: "Inspect", turn: { startedAt: time } },
    { id: "comment", role: "assistant", text: "Checking" },
    { id: "steer", role: "user", text: "Check the tests too" },
    { id: "reply", role: "assistant", text: "Done" },
    { id: "next", role: "user", text: "Continue", turn: { startedAt: time } },
  ];
  const activities = [
    tool("one", "first"),
    tool("two", "comment"),
    tool("three", "steer"),
    tool("four", "reply"),
    tool("five", "next"),
  ];
  const groups = groupTurnActivity({ messages, toolActivities: activities });
  expect(groups.get("first")).toEqual(activities.slice(0, 4));
  expect(groups.get("next")).toEqual([activities[4]]);
  expect(groups.size).toBe(2);
});

test("older conversations keep separate prompt groups and omitted anchors do not create empty groups", () => {
  const messages: Thread["messages"] = [
    { id: "first", role: "user", text: "Inspect" },
    { id: "reply", role: "assistant", text: "Done" },
    { id: "next", role: "user", text: "Continue" },
  ];
  const activities = [tool("one", "reply"), tool("two", "next"), tool("missing", "omitted")];
  const groups = groupTurnActivity({ messages, toolActivities: activities });
  expect(groups.get("first")).toEqual([activities[0]]);
  expect(groups.get("next")).toEqual([activities[1]]);
  expect(groups.size).toBe(2);
});

test("streaming replies retain completed turn groups while changed tools replace only their group", () => {
  const messages: Thread["messages"] = [
    { id: "first", role: "user", text: "Inspect", turn: { startedAt: time, endedAt: time } },
    { id: "reply", role: "assistant", text: "Done" },
    { id: "next", role: "user", text: "Continue", turn: { startedAt: time } },
    { id: "stream", role: "assistant", text: "Checking" },
  ];
  const activities = [tool("one", "first"), tool("two", "next")];
  const original = groupTurnActivity({ messages, toolActivities: activities });
  const streamed = groupTurnActivity(
    {
      messages: [...messages.slice(0, -1), { ...messages[3], text: "Checking the tests" }],
      toolActivities: activities,
    },
    original,
  );
  expect(streamed.get("first")).toBe(original.get("first"));
  expect(streamed.get("next")).toBe(original.get("next"));
  const changed = { ...activities[1], output: "Tests passed" };
  const updated = groupTurnActivity(
    { messages, toolActivities: [activities[0], changed] },
    streamed,
  );
  expect(updated.get("first")).toBe(original.get("first"));
  expect(updated.get("next")).not.toBe(streamed.get("next"));
  expect(updated.get("next")).toEqual([changed]);
  expect(original.get("next")).toEqual([activities[1]]);
});

test("retained groups reconcile reordered tools, changed turn ownership and pruned history", () => {
  const messages: Thread["messages"] = [
    { id: "first", role: "user", text: "Inspect", turn: { startedAt: time } },
    { id: "steer", role: "user", text: "Check the tests" },
  ];
  const activities = [tool("one", "first"), tool("two", "first"), tool("three", "steer")];
  const original = groupTurnActivity({ messages, toolActivities: activities });
  const reordered = groupTurnActivity(
    { messages, toolActivities: [activities[1], activities[0], activities[2]] },
    original,
  );
  expect(reordered.get("first")).toEqual([activities[1], activities[0], activities[2]]);
  const separated = groupTurnActivity(
    {
      messages: [messages[0], { ...messages[1], turn: { startedAt: time } }],
      toolActivities: activities,
    },
    reordered,
  );
  expect(separated.get("first")).toEqual(activities.slice(0, 2));
  expect(separated.get("steer")).toEqual([activities[2]]);
  const pruned = groupTurnActivity(
    { messages: [messages[1]], toolActivities: [activities[2]] },
    separated,
  );
  expect(pruned.has("first")).toBe(false);
  expect(pruned.get("steer")).toBe(separated.get("steer"));
  expect(groupTurnActivity({ messages, toolActivities: [] }, pruned).size).toBe(0);
  expect(original.get("first")).toEqual(activities);
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
  const original = groupTurnActivity(initial);
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
  const retained = groupTurnActivity(streamed, original);
  expect(retained.get(userId)).toBe(original.get(userId));
  const updated = applyThreadPatch(
    streamed,
    receive(3, [{ ...toolActivities[0], output: "Passed" }]),
  );
  const changed = groupTurnActivity(updated, retained);
  expect(changed.get(userId)).not.toBe(retained.get(userId));
  expect(changed.get(userId)?.[0].output).toBe("Passed");
  expect(original.get(userId)?.[0].output).toBeUndefined();
});
