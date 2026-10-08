import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("auth cancellation destroys its Postgres client and prevents a subsequent query", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock } from "bun:test";
    let released = 0, writes = 0, unblock;
    const blocked = new Promise(resolve => { unblock = resolve; });
    mock.module("@opennextjs/cloudflare", () => ({ getCloudflareContext() { throw new Error("Node test"); } }));
    mock.module("pg", () => ({ Pool: class {
      connect(callback) { callback(undefined, {
        query: async sql => { writes++; if (sql === "first") await blocked; return { rows: [] }; },
        release: error => { if (error === true) released++; },
      }); }
    } }));
    const { db } = await import("./lib/db.ts");
    const { handleAuthRequest } = await import("./lib/auth/request-boundary.ts");
    const result = await handleAuthRequest(new Request("https://auth.test/api/auth/update-user", { method: "POST" }), async () => {
      const client = await db.connect();
      try { await client.query("first"); await client.query("late-write"); return Response.json({ ok: true }); }
      finally { client.release(); }
    }, 20);
    unblock();
    await new Promise(resolve => setTimeout(resolve, 5));
    console.log(JSON.stringify({ status: result.status, released, writes }));
  `,
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 2000,
    },
  );
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({ status: 503, released: 1, writes: 1 });
});
