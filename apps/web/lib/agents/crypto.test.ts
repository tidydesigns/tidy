import { expect, test } from "bun:test";
import { openSecret, sealSecret } from "./crypto";

test("provider secrets are bound to their owner, purpose and encryption key", () => {
  const key = Buffer.alloc(32, 3),
    secret = { access_token: "private", refresh_token: "renew" };
  const sealed = sealSecret(secret, key, "alice", "connection");
  expect(openSecret(sealed, key, "alice", "connection")).toEqual(secret);
  expect(() => openSecret(sealed, key, "bob", "connection")).toThrow();
  expect(() => openSecret(sealed, key, "alice", "oauth")).toThrow();
  expect(() => openSecret(sealed, Buffer.alloc(32, 4), "alice", "connection")).toThrow();
  expect(JSON.stringify(sealed)).not.toContain("private");
  expect(sealSecret(secret, key, "alice", "connection")).not.toEqual(sealed);
});
