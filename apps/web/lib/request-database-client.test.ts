import { expect, test } from "bun:test";
import type { PoolClient } from "pg";
import { requestDatabaseClient } from "./request-database-client";
import { runWithRequestSignal, requestPhases } from "./request-lifecycle";

test("canceling an invocation destroys its checked-out client exactly once and blocks later queries", async () => {
  const controller = new AbortController();
  const releases: unknown[] = [];
  let calls = 0;
  const raw = {
    release(error: unknown) {
      releases.push(error);
    },
    query() {
      calls++;
      return Promise.resolve({ rows: [] });
    },
  } as unknown as PoolClient;
  await runWithRequestSignal(controller.signal, async () => {
    const client = requestDatabaseClient(raw);
    await client.query("select 1");
    controller.abort();
    expect(() => client.query("select 2")).toThrow();
    client.release();
  });
  expect(calls).toBe(1);
  expect(releases).toEqual([true]);
});

test("successful release detaches cancellation and records only pending queries", async () => {
  const controller = new AbortController();
  let releases = 0;
  let resolve!: (value: unknown) => void;
  const raw = {
    release() {
      releases++;
    },
    query() {
      return new Promise((done) => {
        resolve = done;
      });
    },
  } as unknown as PoolClient;
  await runWithRequestSignal(controller.signal, async () => {
    const client = requestDatabaseClient(raw);
    const query = client.query("select 1");
    expect(requestPhases()).toEqual(["database_query"]);
    resolve({ rows: [] });
    await query;
    expect(requestPhases()).toEqual([]);
    client.release();
    controller.abort();
  });
  expect(releases).toBe(1);
});

test("callback queries preserve arguments and clear their phase on errors", async () => {
  const error = new Error("database failure");
  const raw = {
    release() {},
    query(_sql: unknown, callback: (error: Error) => void) {
      callback(error);
    },
  } as unknown as PoolClient;
  await runWithRequestSignal(new AbortController().signal, async () => {
    requestDatabaseClient(raw).query("select 1", (value) => {
      expect(value).toBe(error);
      expect(requestPhases()).toEqual([]);
    });
  });
});

test("canceling a callback query completes once even if the driver responds later", async () => {
  const controller = new AbortController();
  let driverCallback!: (...args: unknown[]) => void;
  let calls = 0;
  const raw = {
    release() {},
    query(_sql: unknown, callback: typeof driverCallback) {
      driverCallback = callback;
    },
  } as unknown as PoolClient;
  await runWithRequestSignal(controller.signal, async () => {
    requestDatabaseClient(raw).query("select 1", (error) => {
      calls++;
      expect(error).toBe(controller.signal.reason);
    });
    controller.abort();
    expect(requestPhases()).toEqual([]);
    driverCallback(null, { rows: [] });
  });
  expect(calls).toBe(1);
});
