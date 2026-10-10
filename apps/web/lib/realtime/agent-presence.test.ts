import { expect, test } from "bun:test";
import { agentPresences, presenceDeadline } from "./agent-presence";
import type { AgentActivity } from "./agent-activity";

const now = 10_000;
const activity = (overrides: Partial<AgentActivity> = {}): AgentActivity => ({
  id: crypto.randomUUID(),
  actorId: "codex",
  actorName: "Codex",
  fileId: "file",
  phase: "editing",
  tool: "patch_document",
  version: 0,
  updatedAt: now,
  expiresAt: now + 60_000,
  ...overrides,
});

test("one stable presence follows the newest edit without a concurrent read stealing focus", () => {
  const edit = activity();
  const read = activity({ phase: "reading", updatedAt: now + 1 });
  expect(agentPresences([read, edit], now + 1)).toEqual([edit]);
  const next = activity({ updatedAt: now + 2, nodeIds: ["next-layer"] });
  expect(agentPresences([read, edit, next], now + 2)).toEqual([next]);
});

test("expired work cannot hide a fresh completed edit", () => {
  const expired = activity({ expiresAt: now });
  const completed = activity({ phase: "completed" });
  expect(agentPresences([expired, completed], now)).toEqual([completed]);
  expect(agentPresences([completed], now + 6000)).toEqual([]);
  expect(presenceDeadline(completed)).toBe(now + 6000);
});

test("an import advances through calls without resurrecting old staged work", () => {
  const importId = crypto.randomUUID();
  const staged = activity({ importId, phase: "staged" });
  const published = activity({ importId, phase: "published", updatedAt: now + 1 });
  expect(agentPresences([staged, published], now + 1)).toEqual([published]);
  expect(agentPresences([staged, published], now + 6001)).toEqual([]);
});

test("clients stay distinct and native thread agents retain their own UI", () => {
  const first = activity();
  const second = activity({ actorId: "claude" });
  const native = activity({ threadId: crypto.randomUUID(), agentId: crypto.randomUUID() });
  expect(agentPresences([first, second, native], now)).toEqual([first, second]);
});
