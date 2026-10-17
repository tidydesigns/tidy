import { expect, test } from "bun:test";
import { fetchWithRateLimitRetry, retryAfterMilliseconds, waitForRetry } from "./retry-after";
import { blankDesignDocument } from "./design/document";
import { RoomEditQueue } from "./design/room-edit-queue";

test("Retry-After supports seconds and dates with a safe delay for invalid values", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  expect(retryAfterMilliseconds("60", now)).toBe(60_000);
  expect(retryAfterMilliseconds("Thu, 01 Jan 2026 00:01:00 GMT", now)).toBe(60_000);
  for (const value of [null, "", "invalid", "-1", "Wed, 31 Dec 2025 23:59:00 GMT"])
    expect(retryAfterMilliseconds(value, now)).toBe(1000);
  expect(retryAfterMilliseconds("0", now)).toBe(250);
});

test("a throttled edit retains its identity and navigation protection until acknowledged", async () => {
  const snapshot = { revision: 1, content: blankDesignDocument() };
  const queue = new RoomEditQueue(snapshot, () => {});
  const controller = new AbortController();
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  const ids: string[] = [];
  const submitted = queue.commit([], async (operationId) => {
    await fetchWithRateLimitRetry(
      async () => {
        ids.push(operationId);
        return ids.length === 1
          ? Response.json({ error: "Busy" }, { status: 429, headers: { "Retry-After": "60" } })
          : Response.json({ ok: true });
      },
      controller.signal,
      async (delay) => {
        expect(delay).toBeGreaterThanOrEqual(60_000);
        expect(delay).toBeLessThan(60_250);
        entered();
        await new Promise<void>((resolve) => (release = resolve));
      },
    );
    return { patch: [], snapshot, sequence: 1 };
  });
  await waiting;
  expect(queue.hasPendingEdits).toBe(true);
  expect(ids).toHaveLength(1);
  release();
  await submitted;
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(queue.hasPendingEdits).toBe(false);
});

test("closing the file cancels a throttled wait without sending another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  const pending = fetchWithRateLimitRetry(
    async () => {
      calls++;
      return new Response(null, { status: 429, headers: { "Retry-After": "3600" } });
    },
    controller.signal,
    (delay, signal) => {
      entered();
      return waitForRetry(delay, signal);
    },
  ).catch((error: unknown) => error);
  await waiting;
  controller.abort(new Error("File closed"));
  expect(await pending).toBe(controller.signal.reason);
  expect(calls).toBe(1);
});

test("explicit permission and validation failures are not retried", async () => {
  for (const status of [400, 401, 403, 409, 410]) {
    let calls = 0;
    const response = await fetchWithRateLimitRetry(async () => {
      calls++;
      return new Response(null, { status });
    }, new AbortController().signal);
    expect(response.status).toBe(status);
    expect(calls).toBe(1);
  }
});
