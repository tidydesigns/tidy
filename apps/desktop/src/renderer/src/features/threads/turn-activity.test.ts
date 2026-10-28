import { expect, test } from "bun:test";
import type { Thread } from "../../../../shared/contracts/desktop";
import type { ToolActivity } from "../../../../shared/contracts/tool-activity";
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
