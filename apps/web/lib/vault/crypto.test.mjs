import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { decryptCredentials, encryptCredentials } from "./crypto";

test("vault credentials round-trip without storing plaintext", () => {
  const key = randomBytes(32);
  const credentials = { username: "person@example.com", password: "a private password" };
  const encrypted = encryptCredentials(credentials, key, "user-1", "login-1");

  expect(JSON.stringify(encrypted)).not.toContain(credentials.username);
  expect(JSON.stringify(encrypted)).not.toContain(credentials.password);
  expect(decryptCredentials(encrypted, key, "user-1", "login-1")).toEqual(credentials);
});

test("vault credentials reject tampering and a different record context", () => {
  const key = randomBytes(32);
  const encrypted = encryptCredentials(
    { username: "user", password: "secret" },
    key,
    "user-1",
    "login-1",
  );
  const changed = { ...encrypted, ciphertext: Buffer.from("changed").toString("base64") };

  expect(() => decryptCredentials(changed, key, "user-1", "login-1")).toThrow();
  expect(() => decryptCredentials(encrypted, key, "user-2", "login-1")).toThrow();
  expect(() => decryptCredentials(encrypted, key, "user-1", "login-2")).toThrow();
  expect(() => decryptCredentials(encrypted, randomBytes(32), "user-1", "login-1")).toThrow();
});
