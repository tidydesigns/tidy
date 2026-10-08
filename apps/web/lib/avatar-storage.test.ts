import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { avatarBytes, avatarObjectKey, avatarPath, MAX_IMAGE_BYTES } from "./avatars";
import { readUploadForm } from "./feedback/validation";

test("avatars reject unsupported, oversized and disguised images", async () => {
  await expect(
    avatarBytes(new File(["<svg/>"], "icon.svg", { type: "image/svg+xml" })),
  ).rejects.toThrow("PNG");
  await expect(
    avatarBytes(new File(["not a PNG"], "icon.png", { type: "image/png" })),
  ).rejects.toThrow("contents");
  await expect(
    avatarBytes(new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "big.png", { type: "image/png" })),
  ).rejects.toThrow("5 MB");
  await expect(avatarBytes(new File([], "empty.png", { type: "image/png" }))).rejects.toThrow(
    "5 MB",
  );
  const request = new Request("https://app.test", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=test" },
    body: new Uint8Array(65),
  });
  await expect(readUploadForm(request, 64)).rejects.toThrow("too large");
});

test("cleanup only accepts a generated avatar belonging to the target", () => {
  const version = "12345678-1234-4123-8123-123456789012";
  expect(avatarObjectKey(`${avatarPath("user", "owner")}?v=${version}`, "user", "owner")).toBe(
    `avatars/user/owner/${version}`,
  );
  expect(avatarObjectKey(`https://external.test/image.png`, "user", "owner")).toBeNull();
  expect(avatarObjectKey(`/api/avatars/user/other?v=${version}`, "user", "owner")).toBeNull();
  expect(
    avatarObjectKey(`/api/avatars/user/owner?v=../../originals/file`, "user", "owner"),
  ).toBeNull();
});

test("avatar HTTP endpoints enforce ownership, membership, origin, replacement and failure safety", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock, expect } from "bun:test";
    let session = { user: { id: "owner" } }, role = "owner", shared = true;
    let failPut = false, failUpdate = false, failCommit = false, failDelete = false;
    let gets = 0, puts = 0, snapshot;
    const rows = { user: "https://external.test/original.png", organization: null };
    const objects = new Map();
    const bucket = {
      put: async (key, bytes, options) => { puts++; if (failPut) throw new Error("R2 unavailable"); objects.set(key, { bytes, options }); },
      delete: async key => { if (failDelete) throw new Error("R2 unavailable"); objects.delete(key); },
      get: async key => { gets++; const value = objects.get(key); return value ? { body: value.bytes, httpMetadata: value.options.httpMetadata } : null; },
    };
    const query = async (sql, values = []) => {
      if (sql === "begin") snapshot = { ...rows };
      if (sql === "rollback" && !failCommit) Object.assign(rows, snapshot);
      if (sql === "commit" && failCommit) throw new Error("Commit response lost");
      if (sql.startsWith('select "role"')) return { rows: role ? [{ role }] : [] };
      if (sql.startsWith('select 1')) return { rows: shared ? [{}] : [] };
      if (sql.startsWith('select "image"')) return { rows: [{ image: rows.user }] };
      if (sql.startsWith('select "logo"')) return { rows: [{ image: rows.organization }] };
      if (sql.startsWith('update')) { if (failUpdate) throw new Error("Database unavailable"); rows[sql.includes('"user"') ? "user" : "organization"] = values[1]; }
      return { rows: [] };
    };
    mock.module("@/lib/db", () => ({ db: { query, connect: async () => ({ query, release() {} }) } }));
    mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => session } } }));
    mock.module("@/lib/storage/design-objects", () => ({ designBucket: () => bucket }));
    const { GET, POST, DELETE } = await import("./app/api/avatars/[kind]/[id]/route.ts");
    const { avatarObjectKey } = await import("./lib/avatars.ts");
    process.env.BETTER_AUTH_URL = "https://app.test";
    const bytes = new Uint8Array([137,80,78,71,13,10,26,10]);
    const context = kind => ({ params: Promise.resolve({ kind, id: kind === "user" ? "owner" : "org" }) });
    const upload = (kind = "user", origin = "https://app.test", image = bytes) => {
      const form = new FormData(); form.append("image", new File([image], "photo.png", { type: "image/png" }));
      return POST(new Request("https://app.test/api/avatars/" + kind + "/owner", { method: "POST", headers: { origin }, body: form }), context(kind));
    };
    const remove = kind => DELETE(new Request("https://app.test/api", { method: "DELETE", headers: { origin: "https://app.test" } }), context(kind));
    const read = (url, kind = "user") => GET(new Request("https://app.test" + url), context(kind));
    expect((await upload("user", "https://evil.test")).status).toBe(403);
    session = null; expect((await upload()).status).toBe(401);
    session = { user: { id: "other" } }; expect((await upload()).status).toBe(403);
    expect((await remove("user")).status).toBe(403);
    session = { user: { id: "owner" } };
    expect((await upload("user", "https://app.test", new Uint8Array([1,2,3]))).status).toBe(400);
    expect(puts).toBe(0);
    const first = await upload(); expect(first.status).toBe(200);
    const firstURL = (await first.json()).image;
    const firstKey = avatarObjectKey(firstURL, "user", "owner");
    expect(objects.has(firstKey)).toBe(true);
    const response = await read(firstURL); expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const before = gets;
    session = null; expect((await read(firstURL)).status).toBe(401);
    session = { user: { id: "other" } }; shared = false;
    expect((await read(firstURL)).status).toBe(404); expect(gets).toBe(before);
    shared = true; expect((await read(firstURL)).status).toBe(200);
    session = { user: { id: "owner" } };
    failPut = true; expect((await upload()).status).toBe(503); failPut = false;
    expect(rows.user).toBe(firstURL); expect(objects.size).toBe(1);
    failUpdate = true; expect((await upload()).status).toBe(503); failUpdate = false;
    expect(rows.user).toBe(firstURL); expect(objects.size).toBe(1);
    const second = await upload(); expect(second.status).toBe(200);
    const secondURL = (await second.json()).image;
    expect(secondURL).not.toBe(firstURL); expect(objects.has(firstKey)).toBe(false);
    expect((await read(firstURL)).status).toBe(404);
    failCommit = true; expect((await upload()).status).toBe(503); failCommit = false;
    expect(objects.has(avatarObjectKey(rows.user, "user", "owner"))).toBe(true);
    failDelete = true; expect((await remove("user")).status).toBe(200); failDelete = false;
    expect(rows.user).toBeNull(); expect((await read(secondURL)).status).toBe(404);
    for (const denied of [null, "viewer", "editor", "member"]) {
      role = denied; expect((await upload("organization")).status).toBe(403); expect((await remove("organization")).status).toBe(403);
    }
    for (const allowed of ["admin", "owner"]) {
      role = allowed; expect((await upload("organization")).status).toBe(200);
    }
    const orgURL = rows.organization;
    role = "viewer"; expect((await read(orgURL, "organization")).status).toBe(200);
    role = null; expect((await read(orgURL, "organization")).status).toBe(404);
    role = "owner"; expect((await remove("organization")).status).toBe(200);
    expect(rows.organization).toBeNull();
    console.log("PASS");
  `,
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  expect(new TextDecoder().decode(child.stdout)).toContain("PASS");
});
