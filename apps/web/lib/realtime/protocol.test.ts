import { expect, test } from "bun:test";
import { EMPTY_PRESENCE, readRoomMessage, type Peer, type RoomMessage } from "./protocol";
import { PresenceStore } from "./presence-store";

const peer = {
  ...EMPTY_PRESENCE,
  userId: "user",
  name: "",
  image: null,
  sessionId: crypto.randomUUID(),
  color: "#4477dd",
  updatedAt: Date.now(),
} satisfies Peer;

test("room frames validate every variant before reaching consumers", () => {
  const frames: RoomMessage[] = [
    { type: "ready" },
    { type: "pong" },
    { type: "access", canEdit: false },
    { type: "peers", peers: [peer] },
    { type: "presence", peer },
    { type: "leave", sessionId: peer.sessionId },
    { type: "events", events: [{ sequence: 12, kind: "document" }] },
    { type: "activities", activities: [] },
    {
      type: "activity",
      activity: {
        id: crypto.randomUUID(),
        version: 1,
        fileId: "file",
        actorId: "actor",
        actorName: "Agent",
        tool: "edit",
        phase: "editing",
        updatedAt: Date.now(),
        expiresAt: Date.now() + 5000,
      },
    },
  ];
  for (const frame of frames) expect(readRoomMessage(JSON.stringify(frame))).toEqual(frame);
});

test("malformed and future frames cannot throw or replace valid presence", () => {
  const store = new PresenceStore();
  store.replace([peer]);
  const before = store.getSnapshot();
  for (const value of [
    null,
    {},
    "not JSON",
    "null",
    "[]",
    JSON.stringify({ type: "future" }),
    JSON.stringify({ type: "peers", peers: [null] }),
    JSON.stringify({ type: "presence", peer: { ...peer, cursor: { x: "bad", y: 1 } } }),
    JSON.stringify({ type: "events", events: [{ sequence: "12", kind: "document" }] }),
    JSON.stringify({ type: "activities", activities: [null] }),
    JSON.stringify({ type: "access", canEdit: "false" }),
  ]) {
    const frame = readRoomMessage(value);
    if (frame?.type === "peers") store.replace(frame.peers);
    expect(frame).toBeNull();
  }
  expect(store.getSnapshot()).toBe(before);
  expect(readRoomMessage(JSON.stringify({ type: "ready", newField: true }))).toEqual({
    type: "ready",
  });
  expect(
    readRoomMessage(JSON.stringify({ type: "presence", peer: { ...peer, newField: true } })),
  ).toEqual({ type: "presence", peer });
});
