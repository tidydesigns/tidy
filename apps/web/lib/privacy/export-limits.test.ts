import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("export preflight rejects oversized sections before materializing records and releases capacity", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
      import { mock, expect } from "bun:test";
      mock.module("server-only", () => ({}));
      mock.module("@/lib/privacy/access", () => ({
        lockPrivacyAccount: async () => {},
        PrivacyError: class extends Error { constructor(message, status) { super(message); this.status = status; } },
      }));
      let oversize = true, materialized = 0, rolledBack = 0, released = 0;
      mock.module("@/lib/db", () => ({ db: { connect: async () => ({
        async query(sql) {
          if (sql.includes("row_to_json(export_row)"))
            return { rows: [{ count: 1, bytes: oversize && sql.includes("d.content") ? "8000001" : "2" }] };
          if (sql === "rollback") rolledBack++;
          if (sql.startsWith("select ")) materialized++;
          return { rows: [] };
        },
        release() { released++; },
      }) } }));
      const { exportAccount } = await import("./lib/privacy/export.ts");
      const failure = await exportAccount("alice", "session").catch(error => error);
      expect(failure.status).toBe(413);
      expect(materialized).toBe(0);
      expect(rolledBack).toBe(1);
      expect(released).toBe(1);
      oversize = false;
      expect((await exportAccount("alice", "session")).documents).toEqual([]);
      expect(materialized).toBeGreaterThan(0);
      expect(released).toBe(2);
      console.log("PASS");
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
  expect(child.stdout.toString()).toContain("PASS");
});
