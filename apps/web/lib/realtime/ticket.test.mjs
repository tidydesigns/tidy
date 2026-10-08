import { test, expect } from "bun:test";
import { signTicket, verifyTicket } from "./ticket";
import { presenceSchema } from "./protocol";
import { PresenceStore } from "./presence-store";
const secret = "local-test-secret-with-at-least-32-characters";
const ticket = () => ({
  purpose: "file-room",
  fileId: "file",
  organizationId: "org",
  userId: "user",
  name: "Écho 🧑‍🎨",
  image: null,
  sessionId: crypto.randomUUID(),
  authSessionId: "auth-session",
  expiresAt: Date.now() + 60_000,
});
test("signed presence tickets preserve Unicode identity and reject tampering", async () => {
  const claims = ticket(),
    token = await signTicket(claims, secret);
  expect(await verifyTicket(token, secret)).toEqual(claims);
  const [payload, signature] = token.split(".");
  // The final base64url character contains padding bits; alter actual signature bits.
  const tampered = (signature.startsWith("a") ? "b" : "a") + signature.slice(1);
  expect(await verifyTicket(`${payload}.${tampered}`, secret)).toBeNull();
  expect(await verifyTicket(token, "another-secret-with-at-least-32-characters")).toBeNull();
});
test("expired and oversized tickets fail closed", async () => {
  expect(
    await verifyTicket(
      await signTicket({ ...ticket(), expiresAt: Date.now() - 1 }, secret),
      secret,
    ),
  ).toBeNull();
  expect(await verifyTicket("x".repeat(7000), secret)).toBeNull();
});
test("alternate signature encodings and extra separators fail closed", async () => {
  const token = await signTicket(ticket(), secret);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const index = alphabet.indexOf(token.at(-1));
  // A SHA-256 MAC's final base64 character has two unused bits.
  for (const paddingBits of [1, 2, 3]) {
    const alias = token.slice(0, -1) + alphabet[index | paddingBits];
    expect(await verifyTicket(alias, secret)).toBeNull();
  }
  expect(await verifyTicket(`${token}.`, secret)).toBeNull();
});
test("presence payloads reject actor spoofing and invalid positions", () => {
  const presence = {
    pageId: "page-1",
    cursor: { x: 1, y: 1 },
    selectedIds: [],
    action: null,
    away: false,
    preview: null,
  };
  expect(presenceSchema.safeParse({ ...presence, userId: "another-user" }).success).toBe(false);
  expect(presenceSchema.safeParse({ ...presence, cursor: { x: Infinity, y: 1 } }).success).toBe(
    false,
  );
});
test("pointer traffic does not change avatar or selection snapshots", () => {
  const store = new PresenceStore();
  const peer = {
    userId: "user",
    sessionId: "peer",
    name: "Echo",
    image: null,
    color: "#4477dd",
    updatedAt: Date.now(),
    pageId: "page-1",
    cursor: { x: 1, y: 1 },
    selectedIds: [],
    action: null,
    away: false,
    preview: null,
  };
  store.update(peer);
  const users = store.getUsersSnapshot(),
    decorations = store.getDecorationsSnapshot();
  store.update({ ...peer, cursor: { x: 200, y: 200 }, updatedAt: Date.now() });
  expect(store.getUsersSnapshot()).toBe(users);
  expect(store.getDecorationsSnapshot()).toBe(decorations);
  expect(store.getSnapshot()[0].cursor).toEqual({ x: 200, y: 200 });
});
