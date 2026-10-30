import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestReceipts, unavailableReceiptResponse } from "./receipts";

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

test("void command receipts survive recovery without replaying an authorized Stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "void-receipts-"));
  roots.push(root);
  const client = randomUUID(),
    projectId = randomUUID();
  const request = {
    id: randomUUID(),
    name: "stop-thread-port",
    input: { projectId, threadId: randomUUID(), portId: randomUUID() },
  };
  let calls = 0;
  const action = async () => {
    calls++;
  };
  const authorize = async (id: string) => {
    expect(id).toBe(projectId);
  };
  await new RequestReceipts(root).execute(client, request, action, authorize);
  const reopened = new RequestReceipts(root);
  expect(await reopened.status(client, request.id, authorize)).toEqual({
    kind: "complete",
    response: { ok: true },
  });
  expect(await reopened.execute(client, request, action, authorize)).toEqual({ ok: true });
  expect(calls).toBe(1);
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

test("stored project results require current authorization without replaying completed work", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipt-access-"));
  roots.push(root);
  const client = randomUUID();
  const projectId = randomUUID();
  const request = { id: randomUUID(), name: "create-design", input: { projectId } };
  let allowed = true;
  let calls = 0;
  const authorize = async (id: string) => {
    expect(id).toBe(projectId);
    if (!allowed) throw new Error("Access withdrawn");
  };
  const action = async () => {
    calls++;
    return { private: "project result" };
  };
  const receipts = new RequestReceipts(root);
  const original = await receipts.execute(client, request, action, authorize);
  expect(original.ok).toBe(true);
  allowed = false;
  const reopened = new RequestReceipts(root);
  expect(await reopened.status(client, request.id, authorize)).toEqual({
    kind: "complete",
    response: unavailableReceiptResponse,
  });
  expect(await reopened.execute(client, request, action, authorize)).toEqual(
    unavailableReceiptResponse,
  );
  expect(await reopened.status(client, request.id)).toEqual({
    kind: "complete",
    response: unavailableReceiptResponse,
  });
  allowed = true;
  expect(await reopened.execute(client, request, action, authorize)).toEqual(original);
  expect(calls).toBe(1);
});

test("concurrent project commands recheck access after execution and preserve replay protection", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipt-concurrent-access-"));
  roots.push(root);
  const receipts = new RequestReceipts(root);
  const client = randomUUID();
  const request = { id: randomUUID(), name: "select-project", input: randomUUID() };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let allowed = true;
  let calls = 0;
  const action = async () => {
    calls++;
    entered.resolve();
    await release.promise;
    return "private snapshot";
  };
  const authorize = async () => {
    if (!allowed) throw new Error("Access withdrawn");
  };
  const first = receipts.execute(client, request, action, authorize);
  await entered.promise;
  const second = receipts.execute(client, request, action, authorize);
  allowed = false;
  release.resolve();
  expect(await Promise.all([first, second])).toEqual([
    unavailableReceiptResponse,
    unavailableReceiptResponse,
  ]);
  expect(calls).toBe(1);
});

test("legacy receipts without an authorization scope cannot disclose results or replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipt-legacy-access-"));
  roots.push(root);
  const receipts = new RequestReceipts(root);
  const client = randomUUID();
  const request = { id: randomUUID(), name: "create-design" };
  let calls = 0;
  const action = async () => {
    calls++;
    return "historical result";
  };
  await receipts.execute(client, request, action);
  const path = join(root, client + "-" + request.id + ".json");
  const record = JSON.parse(await readFile(path, "utf8"));
  delete record.scope;
  await writeFile(path, JSON.stringify(record));
  const reopened = new RequestReceipts(root);
  expect(await reopened.execute(client, request, action)).toEqual(unavailableReceiptResponse);
  expect(await reopened.status(client, request.id)).toEqual({
    kind: "complete",
    response: unavailableReceiptResponse,
  });
  expect(calls).toBe(1);
});

test("setup receipts protect the project returned by the operation after access changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipt-setup-access-"));
  roots.push(root);
  const receipts = new RequestReceipts(root),
    client = randomUUID(),
    projectId = randomUUID();
  const request = {
    id: randomUUID(),
    name: "setup-project",
    input: { kind: "folder", path: "/project", repository: null },
  };
  let allowed = true,
    calls = 0;
  const authorize = async (id: string) => {
    expect(id).toBe(projectId);
    if (!allowed) throw new Error("Access withdrawn");
  };
  const action = async () => {
    calls++;
    return {
      kind: "ready",
      snapshot: {
        project: {
          id: projectId,
          name: "Project",
          path: "/project",
          openedAt: new Date().toISOString(),
        },
        threads: [],
        designs: [],
        folders: [],
      },
    };
  };
  const result = await receipts.execute(client, request, action, authorize);
  expect(result.ok).toBe(true);
  allowed = false;
  const reopened = new RequestReceipts(root);
  expect(await reopened.status(client, request.id, authorize)).toEqual({
    kind: "complete",
    response: unavailableReceiptResponse,
  });
  expect(await reopened.execute(client, request, action, authorize)).toEqual(
    unavailableReceiptResponse,
  );
  expect(await reopened.status(client, request.id)).toEqual({
    kind: "complete",
    response: unavailableReceiptResponse,
  });
  expect(calls).toBe(1);
});

test("project removal acknowledgement survives loss of project access and retries once", async () => {
  const root = await mkdtemp(join(tmpdir(), "remove-receipt-"));
  roots.push(root);
  const client = randomUUID();
  const request = { id: randomUUID(), name: "remove-project", input: randomUUID() };
  let calls = 0;
  const action = async () => {
    calls++;
    return null;
  };
  const authorize = async () => {
    throw new Error("Project is no longer registered");
  };
  const receipts = new RequestReceipts(root);
  expect(await receipts.execute(client, request, action, authorize)).toEqual({
    ok: true,
    data: null,
  });
  const reopened = new RequestReceipts(root);
  expect(await reopened.execute(client, request, action, authorize)).toEqual({
    ok: true,
    data: null,
  });
  expect(calls).toBe(1);
});
