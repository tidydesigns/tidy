import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
