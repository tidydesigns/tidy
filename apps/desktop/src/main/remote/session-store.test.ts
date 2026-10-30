import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as filesystem from "node:fs/promises";
import { SessionStore, writePrivateJSON } from "./session-store";

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

test("durable cache writes flush files without opening directories on Windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-windows-"));
  roots.push(root);
  const path = join(root, "cache.json");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platform) throw new Error("Missing process platform descriptor");
  const directoryOpen = spyOn(filesystem, "open");
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    await writePrivateJSON(path, { entries: [] }, { durable: true });
    expect(directoryOpen).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ entries: [] });
  } finally {
    Object.defineProperty(process, "platform", platform);
    directoryOpen.mockRestore();
  }
});

test("stream authorization reuses a bounded credential check and revokes cached access immediately", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-cache-"));
  roots.push(root);
  const directory = join(root, "sessions");
  const store = new SessionStore(directory);
  const clientId = randomUUID();
  const token = await store.issue(clientId);
  const reads = spyOn(filesystem, "readFile");
  try {
    for (let i = 0; i < 20; i++)
      expect(await store.validate(clientId, token, { cached: true })).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(await store.validate(clientId, "0".repeat(64), { cached: true })).toBe(false);
    expect(reads).toHaveBeenCalledTimes(1);
    const revoking = store.revoke(clientId);
    expect(await store.validate(clientId, token, { cached: true })).toBe(false);
    await revoking;
    expect(await store.validate(clientId, token, { cached: true })).toBe(false);
  } finally {
    reads.mockRestore();
  }
});

test("stream authorization rechecks external credential changes within one second", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-cache-expiry-"));
  roots.push(root);
  const directory = join(root, "sessions");
  const store = new SessionStore(directory);
  const clientId = randomUUID();
  const token = await store.issue(clientId);
  expect(await store.validate(clientId, token, { cached: true })).toBe(true);
  await writeFile(join(directory, clientId), "f".repeat(64));
  expect(await store.validate(clientId, token)).toBe(false);
  expect(await store.validate(clientId, token, { cached: true })).toBe(false);
  await writeFile(join(directory, clientId), token);
  expect(await store.validate(clientId, token, { cached: true })).toBe(true);
  await rm(join(directory, clientId));
  await new Promise((resolve) => setTimeout(resolve, 1050));
  expect(await store.validate(clientId, token, { cached: true })).toBe(false);
});

test("credential reads already in flight cannot restore access after revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-cache-race-"));
  roots.push(root);
  const store = new SessionStore(join(root, "sessions"));
  const clientId = randomUUID();
  const token = await store.issue(clientId);
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<string>();
  const read = filesystem.readFile;
  let intercepted = false;
  const delayedRead = (...args: Parameters<typeof read>) => {
    if (!intercepted) {
      intercepted = true;
      started.resolve();
      return resume.promise;
    }
    return Reflect.apply(read, filesystem, args);
  };
  // The intercepted call reads UTF-8; all other readFile overloads use the native implementation.
  const reads = spyOn(filesystem, "readFile").mockImplementation(delayedRead as typeof read);
  try {
    const validating = store.validate(clientId, token, { cached: true });
    await started.promise;
    await store.revoke(clientId);
    resume.resolve(token);
    expect(await validating).toBe(false);
    expect(await store.validate(clientId, token, { cached: true })).toBe(false);
  } finally {
    resume.resolve(token);
    reads.mockRestore();
  }
});
