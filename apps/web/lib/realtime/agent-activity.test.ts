import { expect, test } from "bun:test";
import {
  agentActivitySchema,
  AgentActivityStore,
  activityVisible,
  activityWorking,
  type AgentActivity,
} from "./agent-activity";
const activity = (overrides: Partial<AgentActivity> = {}): AgentActivity => ({
  id: crypto.randomUUID(),
  version: 0,
  fileId: "file",
  actorId: "client",
  actorName: "Codex",
  tool: "patch_document",
  phase: "editing",
  updatedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

test("late starts and duplicate completions cannot undo the newest operation state", () => {
  const store = new AgentActivityStore(),
    start = activity();
  store.update(start);
  store.update({ ...start, version: 2, phase: "completed" });
  const snapshot = store.getSnapshot();
  let changes = 0;
  store.subscribe(() => changes++);
  store.update(start);
  store.update({ ...start, version: 2, phase: "completed" });
  expect(store.getSnapshot()).toBe(snapshot);
  expect(changes).toBe(0);
  store.expire(start.expiresAt + 1);
  store.update(start, start.expiresAt + 2);
  expect(store.getSnapshot()).toEqual([]);
});
test("bounded state survives a room snapshot and keeps concurrent clients distinct", () => {
  const store = new AgentActivityStore();
  for (let i = 0; i < 50; i++) store.update(activity({ actorId: `client-${i}` }));
  for (let i = 0; i < 50; i++) store.update(activity({ phase: "completed" }));
  expect(store.getSnapshot().filter(activityWorking)).toHaveLength(36);
  expect(store.getSnapshot()).toHaveLength(48);
  const revived = new AgentActivityStore();
  revived.replace(store.getSnapshot());
  expect(revived.getSnapshot()).toEqual(store.getSnapshot());
});
test("published imports retire earlier staged markers rather than resurfacing them", () => {
  const store = new AgentActivityStore(),
    importId = crypto.randomUUID();
  store.update(activity({ importId, phase: "staged" }));
  const finish = activity({ importId, phase: "published", version: 2 });
  store.update(finish);
  expect(store.getSnapshot()).toHaveLength(1);
  expect(activityVisible(finish, finish.updatedAt + 6001)).toBe(false);
  expect(activityWorking(finish)).toBe(false);
});
test("lost terminal messages expire into unavailable, never successful", () => {
  const store = new AgentActivityStore(),
    start = activity();
  store.update(start);
  store.expire(start.expiresAt + 1, true);
  expect(store.getSnapshot()[0].phase).toBe("unavailable");
  store.expire(start.expiresAt + 6000, true);
  expect(store.getSnapshot()).toEqual([]);
});
test("hibernation preserves ordering tombstones and closed imports", () => {
  const store = new AgentActivityStore(),
    start = activity({ importId: crypto.randomUUID() });
  store.update(start);
  const finish = {
    ...start,
    version: 2,
    phase: "published" as const,
    expiresAt: start.updatedAt + 30_000,
  };
  store.update(finish);
  store.expire(start.updatedAt + 30_001);
  const revived = new AgentActivityStore();
  revived.restore(store.checkpoint());
  revived.update(start);
  revived.update(activity({ importId: start.importId, phase: "staged" }));
  expect(revived.getSnapshot()).toEqual([]);
});
test("activity rejects raw payloads and oversized UTF-8 messages", () => {
  expect(agentActivitySchema.safeParse({ ...activity(), base64: "private" }).success).toBe(false);
  expect(
    agentActivitySchema.safeParse(
      activity({
        sourcePaths: ["🪴".repeat(48), "🪴".repeat(48), "🪴".repeat(48)],
        sourceProject: "🪴".repeat(40),
        sourceRoute: "🪴".repeat(80),
        nodeIds: ["🪴".repeat(60), "🪴".repeat(60), "🪴".repeat(60)],
      }),
    ).success,
  ).toBe(false);
});
