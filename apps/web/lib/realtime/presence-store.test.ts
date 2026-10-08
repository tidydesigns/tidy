import { expect, test } from "bun:test";
import { PresenceStore } from "./presence-store";
import { EMPTY_PRESENCE, type Peer } from "./protocol";
const peer = (id: string): Peer => ({
  ...EMPTY_PRESENCE,
  sessionId: id,
  userId: id,
  name: id,
  image: null,
  color: "#aabbcc",
  updatedAt: Date.now(),
});
test("cursor traffic preserves user order and decoration snapshots", () => {
  const store = new PresenceStore();
  const a = peer("a"),
    b = peer("b");
  store.replace([a, b]);
  const users = store.getUsersSnapshot(),
    decorations = store.getDecorationsSnapshot();
  store.update({ ...a, cursor: { x: 1, y: 2 } });
  expect(store.getSnapshot().map((peer) => peer.sessionId)).toEqual(["a", "b"]);
  expect(store.getUsersSnapshot()).toBe(users);
  expect(store.getDecorationsSnapshot()).toBe(decorations);
  let updates = 0;
  store.subscribe(() => updates++);
  store.update({ ...a, cursor: { x: 1, y: 2 }, updatedAt: Date.now() + 5000 });
  expect(updates).toBe(0);
  store.update({ ...a, selectedIds: ["node"] });
  expect(store.getDecorationsSnapshot()).not.toBe(decorations);
});
test("expiry reads the newest heartbeat even when no visual update was published", () => {
  const store = new PresenceStore();
  const a = peer("a");
  store.replace([{ ...a, updatedAt: Date.now() - 65_000 }]);
  store.update(a);
  store.expire();
  expect(store.getSnapshot()).toHaveLength(1);
  store.update({ ...a, updatedAt: Date.now() - 65_000 });
  store.expire();
  expect(store.getSnapshot()).toEqual([]);
});
