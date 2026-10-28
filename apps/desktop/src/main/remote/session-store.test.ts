import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "./session-store";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("sessions retain private credentials, validate them and revoke access", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-store-"));
  roots.push(root);
  const directory = join(root, "sessions"),
    clientId = randomUUID();
  const store = new SessionStore(directory);
  const token = await store.issue(clientId);
  expect(await store.issue(clientId)).toBe(token);
  expect((await stat(join(directory, clientId))).mode & 0o777).toBe(0o600);
  expect(await store.validate(clientId, token)).toBe(true);
  expect(await store.validate(clientId, "0".repeat(64))).toBe(false);
  expect(await store.validate(randomUUID(), token)).toBe(false);
  await store.revoke(clientId);
  expect(await store.validate(clientId, token)).toBe(false);
});

test("untrusted session IDs cannot read, replace or delete files outside the session directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-boundary-"));
  roots.push(root);
  const store = new SessionStore(join(root, "sessions"));
  const token = "a".repeat(64),
    sentinel = join(root, "sentinel");
  await writeFile(sentinel, token, { mode: 0o600 });
  for (const clientId of [
    "../sentinel",
    "../../sentinel",
    sentinel,
    "..\\sentinel",
    "%2e%2e%2fsentinel",
    randomUUID() + "/../../sentinel",
    "",
    ".",
    "..",
  ]) {
    expect(await store.validate(clientId, token)).toBe(false);
    await expect(store.issue(clientId)).rejects.toThrow();
    await expect(store.revoke(clientId)).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe(token);
  }
});
