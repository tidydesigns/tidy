import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("account deletion retries expanded memberships before effects and preserves ordinary deletion", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
      import { mock, expect } from "bun:test";
      mock.module("server-only", () => ({}));
      let mode = "added", queries = [], released = 0, locked = false;
      mock.module("@/lib/privacy/access", () => ({
        lockPrivacyAccount: async () => { locked = true; return { id: "alice", email: "alice@example.test", image: null }; },
        PrivacyError: class extends Error { constructor(message, status) { super(message); this.status = status; } },
      }));
      mock.module("@/lib/db", () => ({ db: { connect: async () => ({
        async query(sql, values) {
          queries.push(sql);
          if (sql.startsWith('select "organizationId" from member') && sql.includes('order by'))
            return { rows: [{ organizationId: "org" }] };
          if (sql.includes('from member') && sql.includes('any($2::text[])')) {
            expect(locked).toBe(true);
            expect(values).toEqual(["alice", ["org"]]);
            return { rows: mode === "added" ? [{ organizationId: "new-org" }] : [] };
          }
          return { rows: [] };
        },
        release() { released++; },
      }) } }));
      const { deleteAccount } = await import("./lib/privacy/delete.ts");
      const blocked = await deleteAccount("alice", "session", "alice@example.test").catch(error => error);
      expect(blocked.status).toBe(409);
      expect(blocked.message).toContain("memberships changed");
      expect(queries).toContain("rollback");
      expect(queries).not.toContain("commit");
      expect(queries.some(sql => /^(insert|update|delete)\\b/i.test(sql))).toBe(false);
      expect(released).toBe(1);
      {
        mode = "unchanged"; queries = []; locked = false;
        await deleteAccount("alice", "session", "alice@example.test");
        expect(queries).toContain('delete from "user" where id=$1');
        expect(queries).toContain("commit");
        expect(queries).not.toContain("rollback");
      }
      expect(released).toBe(2);
      console.log("PASS");
      `,
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: "test",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(child.stdout.toString()).toContain("PASS");
});
