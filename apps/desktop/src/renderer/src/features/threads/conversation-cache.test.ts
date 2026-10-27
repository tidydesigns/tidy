import { expect, test } from "bun:test";
import type { Thread } from "../../../../shared/contracts/desktop";
import { retainConversations } from "./conversation-cache";

function thread({
  id,
  count = 2,
  text = "Message",
}: {
  id: string;
  count?: number;
  text?: string;
}): Thread {
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
  const threads = Object.fromEntries(["a", "b", "c", "d"].map((id) => [id, thread({ id })]));
  const recent = ["c", "b", "a"];
  expect(retainConversations({ recent, selected: "b", threads })).toEqual(["b", "c", "a"]);
  expect(retainConversations({ recent, selected: "d", threads })).toEqual(["d", "c", "b"]);
  expect(recent).toEqual(["c", "b", "a"]);
});

test("conversation retention evicts unavailable history while preserving an unloaded selection", () => {
  const threads = { a: thread({ id: "a" }) };
  expect(retainConversations({ recent: ["missing", "a"], selected: "loading", threads })).toEqual([
    "loading",
    "a",
  ]);
  expect(retainConversations({ recent: ["a"], selected: null, threads })).toEqual([null, "a"]);
});

test("conversation retention bounds message count and text while always keeping the selection", () => {
  const threads = {
    a: thread({ id: "a", count: 600 }),
    b: thread({ id: "b", count: 600 }),
    c: thread({ id: "c", count: 20 }),
    large: thread({ id: "large", count: 3, text: "x".repeat(1_000_000) }),
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

test("message budgets admit the exact limit and evict history when the active thread grows", () => {
  const threads = {
    active: thread({ id: "active", count: 600 }),
    history: thread({ id: "history", count: 400 }),
  };
  const recent = ["active", "history"];
  expect(retainConversations({ recent, selected: "active", threads })).toEqual(recent);
  expect(
    retainConversations({
      recent,
      selected: "active",
      threads: { ...threads, active: thread({ id: "active", count: 601 }) },
    }),
  ).toEqual(["active"]);
});

test("text budgets account for the combined conversations and admit the exact limit", () => {
  const threads = {
    active: thread({ id: "active", count: 1, text: "x".repeat(1_000_000) }),
    history: thread({ id: "history", count: 1, text: "y".repeat(1_000_000) }),
  };
  const recent = ["history"];
  expect(retainConversations({ recent, selected: "active", threads })).toEqual([
    "active",
    "history",
  ]);
  expect(
    retainConversations({
      recent,
      selected: "active",
      threads: {
        ...threads,
        active: thread({ id: "active", count: 2, text: "x".repeat(500_001) }),
      },
    }),
  ).toEqual(["active"]);
});
