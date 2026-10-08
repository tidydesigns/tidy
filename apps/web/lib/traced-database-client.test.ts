import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { PoolClient, QueryResult } from "pg";
import { tracedDatabaseClient } from "./traced-database-client";
import { createRequestTrace } from "./request-tracing";

test("database tracing preserves promise results, callback arguments, binding, and release", async () => {
  const trace = createRequestTrace(new Request("https://app.test/files"));
  const result: QueryResult = {
    rows: [{ secret: "private row" }],
    command: "SELECT",
    rowCount: 1,
    oid: 0,
    fields: [],
  };
  let released = false;
  const raw = {
    query(...args: unknown[]) {
      expect(this).toBe(raw);
      const callback = args.at(-1);
      if (typeof callback === "function") {
        queueMicrotask(() => callback(null, result));
        return;
      }
      return Promise.resolve(result);
    },
    release() {
      expect(this).toBe(raw);
      released = true;
    },
  };
  const client = tracedDatabaseClient(raw as unknown as PoolClient);
  await trace.run(async () => {
    expect(await client.query("private SQL", ["private parameter"])).toBe(result);
    expect(trace.operations()).toEqual([]);
    await new Promise<void>((resolve) => {
      client.query("private SQL", [], (error, rows) => {
        expect(error).toBeNull();
        expect(rows).toBe(result);
        expect(trace.operations()).toEqual([]);
        resolve();
      });
      expect(trace.operations()).toEqual(["database.query"]);
    });
    client.release();
    expect(released).toBe(true);
  });
  trace.finish("request_completed");
});

test("database tracing retains synchronous throws and rejected query identity", async () => {
  const trace = createRequestTrace(new Request("https://app.test/files"));
  const failure = Object.assign(new Error("private parameters"), { code: "23505" });
  let sync = false;
  const raw = {
    query() {
      if (sync) throw failure;
      return Promise.reject(failure);
    },
  };
  const client = tracedDatabaseClient(raw as unknown as PoolClient);
  await trace.run(async () => {
    await expect(client.query("private SQL")).rejects.toBe(failure);
    expect(trace.operations()).toEqual([]);
    sync = true;
    try {
      client.query("private SQL");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBe(failure);
    }
    expect(trace.operations()).toEqual([]);
  });
  trace.finish("request_failed", 500, failure);
});

test("Query objects keep their return identity and end the query span on completion", () => {
  const trace = createRequestTrace(new Request("https://app.test/files"));
  const query = new EventEmitter();
  const client = tracedDatabaseClient({ query: () => query } as unknown as PoolClient);
  trace.run(() => {
    expect(client.query("private SQL") as unknown).toBe(query);
    expect(trace.operations()).toEqual(["database.query"]);
    query.emit("end");
    expect(trace.operations()).toEqual([]);
  });
  trace.finish("request_completed");
});
