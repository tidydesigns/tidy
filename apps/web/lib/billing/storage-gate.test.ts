import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("a rejected R2 reservation never writes object bytes, and thumbnails claim their own purpose", () => {
  // Isolate Cloudflare and database mocks from the other integration suites.
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock, expect } from "bun:test";
    let puts = 0, rejectClaim = true;
    const purposes = [];
    mock.module("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: { DESIGN_OBJECTS: {
      put: async () => { puts++; return {}; }
    } } }) }));
    mock.module("@/lib/db", () => ({ db: { query: async (sql, args) => {
      purposes.push(args[5]);
      if (rejectClaim) throw Object.assign(new Error("Free storage is full."), { code: "P0001", detail: JSON.stringify({ code: "PLAN_LIMIT" }) });
      return { rows: [] };
    } } }));
    const { storeDesignObject } = await import("./lib/storage/design-objects.ts");
    await expect(storeDesignObject("org", "image/png", new Uint8Array([1,2,3]))).rejects.toThrow("storage is full");
    expect(puts).toBe(0);
    rejectClaim = false;
    await storeDesignObject("org", "image/png", new Uint8Array([1,2,3]), "thumbnail");
    expect(puts).toBe(1);
    expect(purposes).toEqual(["asset", "thumbnail"]);
  `,
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
});
