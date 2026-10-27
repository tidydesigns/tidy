import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestReceipts } from "./receipts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("command receipts deduplicate concurrent requests and survive reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipts-"));
  roots.push(root);
  const receipts = new RequestReceipts(root);
  const client = randomUUID();
  const request = { id: randomUUID(), name: "create-design", input: {} };
  let calls = 0;
  const action = async () => {
    calls++;
    return { id: "created" };
  };
  const results = await Promise.all([
    receipts.execute(client, request, action),
    receipts.execute(client, request, action),
  ]);
  expect(results[0]).toEqual(results[1]);
  const reopened = new RequestReceipts(root);
  expect(await reopened.execute(client, request, action)).toEqual(results[0]);
  expect(calls).toBe(1);
  await expect(
    reopened.execute(client, { ...request, input: { different: true } }, action),
  ).rejects.toThrow("different request");
  expect(await reopened.status(randomUUID(), request.id)).toEqual({ kind: "missing" });
});

test("an interrupted command is never repeated and is distinguished from live work", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipts-"));
  roots.push(root);
  const receipts = new RequestReceipts(root);
  const client = randomUUID();
  const request = { id: randomUUID(), name: "create-design" };
  let release: () => void = () => {};
  let began: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const work = receipts.execute(client, request, async () => {
    began();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return null;
  });
  await started;
  try {
    expect(await receipts.status(client, request.id)).toEqual({ kind: "pending" });
    const reopened = new RequestReceipts(root);
    expect(await reopened.status(client, request.id)).toEqual({ kind: "interrupted" });
    let repeated = false;
    await expect(
      reopened.execute(client, request, async () => {
        repeated = true;
      }),
    ).rejects.toThrow("may have completed");
    expect(repeated).toBe(false);
  } finally {
    release();
    await work;
  }
});

test("receipt maintenance expires old results while retaining recent results and interrupted work", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipt-retention-"));
  roots.push(root);
  const receipts = new RequestReceipts(root),
    client = randomUUID();
  const expired = { id: randomUUID(), name: "create-design" };
  const recent = { id: randomUUID(), name: "create-design" };
  await receipts.execute(client, expired, async () => ({ value: "old" }));
  await receipts.execute(client, recent, async () => ({ value: "recent" }));
  const pending = randomUUID();
  const path = (id: string) => join(root, client + "-" + id + ".json");
  await writeFile(path(pending), JSON.stringify({ kind: "pending", fingerprint: "fixture" }));
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(path(expired.id), old, old);
  await utimes(path(pending), old, old);
  await receipts.prune();
  expect(await receipts.status(client, expired.id)).toEqual({ kind: "missing" });
  expect((await receipts.status(client, recent.id)).kind).toBe("complete");
  expect(await receipts.status(client, pending)).toEqual({ kind: "interrupted" });
  expect(await readFile(path(pending), "utf8")).toContain('"kind":"pending"');
  receipts.start();
  await receipts.close();
});
