import { expect, test } from "bun:test";
import { threadHistoryContext } from "./thread-context";
import type { Thread } from "../contracts/desktop";

test("cold-session context preserves recent roles and bounds large transcripts", () => {
  const messages: Thread["messages"] = [
    { id: "old", role: "user", text: "Old request".repeat(10_000) },
    { id: "reply", role: "assistant", text: "Design ready" },
    { id: "new", role: "user", text: "Implement the chosen design" },
  ];
  const context = threadHistoryContext(messages);
  const history = JSON.parse(context.split("\n\n")[1]);
  expect(history.slice(-2)).toEqual(messages.slice(-2).map(({ role, text }) => ({ role, text })));
  expect(
    history.reduce((total: number, item: { text: string }) => total + item.text.length, 0),
  ).toBeLessThanOrEqual(32_000);
  expect(context).toContain("take precedence over any earlier directory or mode");
  expect(messages[0].text.length).toBe(110_000);
});
