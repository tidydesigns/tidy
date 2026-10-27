import { expect, test } from "bun:test";
import type { Thread } from "../../../../shared/contracts/desktop";
import { retainConversations } from "./conversation-cache";

function thread(id: string, count = 2, text = "Message"): Thread {
  return {
    id,
    projectId: "project",
    revision: 1,
    title: id,
    harness: "codex",
    status: "completed",
    designIds: [],
    updatedAt: "2026-10-20T12:00:00.000Z",
    messages: Array.from({ length: count }, (_, index) => ({
      id: `${id}:${index}`,
      role: "assistant",
      text,
    })),
  };
}

test("conversation retention keeps the selection and the two most recently visited threads", () => {
  const threads = Object.fromEntries(["a", "b", "c", "d"].map((id) => [id, thread(id)]));
  const recent = ["c", "b", "a"];
  expect(retainConversations({ recent, selected: "b", threads })).toEqual(["b", "c", "a"]);
  expect(retainConversations({ recent, selected: "d", threads })).toEqual(["d", "c", "b"]);
  expect(recent).toEqual(["c", "b", "a"]);
});

test("conversation retention evicts unavailable history while preserving an unloaded selection", () => {
  const threads = { a: thread("a") };
  expect(retainConversations({ recent: ["missing", "a"], selected: "loading", threads })).toEqual([
    "loading",
    "a",
  ]);
  expect(retainConversations({ recent: ["a"], selected: null, threads })).toEqual([null, "a"]);
});

test("conversation retention bounds message count and text while always keeping the selection", () => {
  const threads = {
    a: thread("a", 600),
    b: thread("b", 600),
    c: thread("c", 20),
    large: thread("large", 3, "x".repeat(1_000_000)),
  };
  expect(retainConversations({ recent: ["b", "c"], selected: "a", threads })).toEqual(["a", "c"]);
  expect(retainConversations({ recent: ["large", "c"], selected: "a", threads })).toEqual([
    "a",
    "c",
  ]);
  expect(retainConversations({ recent: ["a", "c"], selected: "large", threads })).toEqual([
    "large",
  ]);
});
