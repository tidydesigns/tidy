import { expect, test } from "bun:test";
import { db } from "./db";
import { handleRequest } from "./request-boundary";

const url = process.env.MULTIPLAYER_TEST_DATABASE_URL;
const enabled =
  !!url &&
  ["127.0.0.1", "localhost"].includes(new URL(url).hostname) &&
  process.env.DATABASE_URL === url;
const integration = enabled ? test : test.skip;

integration(
  "a timed-out database transaction rolls back and the next request can query",
  async () => {
    const table = `request_cancel_${crypto.randomUUID().replaceAll("-", "")}`;
    await db.query(`create table ${table} (id integer)`);
    let querying!: () => void;
    const started = new Promise<void>((resolve) => {
      querying = resolve;
    });
    let canceledWork!: Promise<unknown>;
    const response = handleRequest(
      new Request("https://test/api/files/id/changes", { method: "POST" }),
      async () => {
        canceledWork = (async () => {
          const client = await db.connect();
          try {
            await client.query("begin");
            await client.query(`insert into ${table} values (1)`);
            querying();
            // PostgreSQL may notice socket closure only after the running statement
            // finishes. Keep this finite while checking that COMMIT is prevented.
            await client.query("select pg_sleep(1)");
            await client.query("commit");
            return new Response("ok");
          } finally {
            client.release();
          }
        })();
        return (await canceledWork) as Response;
      },
      100,
    );
    try {
      await started;
      expect((await response).status).toBe(503);
      await expect(canceledWork).rejects.toThrow();
      const check = await handleRequest(
        new Request("https://test/api/files/id/changes"),
        async () => {
          const result = await db.query(`select count(*) as count from ${table}`);
          return Response.json(result.rows[0]);
        },
      );
      expect(await check.text()).toBe('{"count":"0"}');
    } finally {
      await db.query(`drop table ${table}`);
    }
  },
);
