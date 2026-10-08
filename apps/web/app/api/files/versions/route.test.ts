import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("thumbnail version checks require a session and return only accessible revisioned versions", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock } from "bun:test";
    mock.module("server-only", () => ({}));
    let session = null;
    let query = null;
    mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => session } } }));
    mock.module("@/lib/db", () => ({ db: { query: async (sql, values) => {
      query = { sql, values };
      return { rows: [{ id: "visible-file", updatedAt: new Date("2026-09-30T12:00:00.000Z"), revision: 7, thumbnailVersion: "png-v2:7:2026-09-30T12:00:00.000Z" }] };
    } } }));
    const { POST } = await import("./app/api/files/versions/route.ts");
    const request = (ids, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/files/versions", {
      method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify({ ids }),
    });
    const forbidden = await POST(request(["visible-file"], "https://other.example"));
    const anonymous = await POST(request(["visible-file"]));
    session = { user: { id: "member-user" } };
    const invalid = await POST(request(Array(101).fill("visible-file")));
    const response = await POST(request(["visible-file", "other-file"]));
    console.log(JSON.stringify({ forbidden: forbidden.status, anonymous: anonymous.status, invalid: invalid.status,
      status: response.status, cache: response.headers.get("Cache-Control"), body: await response.json(), query }));
  `,
    ],
    { cwd: resolve(import.meta.dir, "../../../.."), stdout: "pipe", stderr: "pipe" },
  );

  expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: "",
  });
  const result = JSON.parse(child.stdout.toString());
  expect([result.forbidden, result.anonymous, result.invalid, result.status]).toEqual([
    403, 401, 400, 200,
  ]);
  expect(result.cache).toBe("private, no-store");
  expect(result.body).toEqual({
    versions: { "visible-file": "7:2026-09-30T12:00:00.000Z" },
    thumbnailVersions: { "visible-file": "png-v2:7:2026-09-30T12:00:00.000Z" },
  });
  expect(result.query.values).toEqual(["member-user", ["visible-file", "other-file"]]);
  expect(result.query.sql).toContain('m."userId" = $1');
});
