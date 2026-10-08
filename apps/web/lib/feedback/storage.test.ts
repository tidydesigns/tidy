import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("uploads are idempotent, rate limited, cleaned up on failure, and private at the HTTP boundary", () => {
  // Keep mocks in a subprocess so the rest of the suite retains real auth and DB modules.
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock, expect } from "bun:test";
    let session = { user: { id: "owner", email: "owner@example.com", emailVerified: true } };
    let row = null, count = 0, puts = 0, deletes = 0, failPut = false, failCommit = false, uuidLock = false;
    const bucket = {
      put: async () => { expect(uuidLock).toBe(true); puts++; if (failPut) throw new Error("R2 unavailable"); },
      delete: async keys => { expect(uuidLock).toBe(true); deletes += keys.length; },
      get: async () => ({ body: "image-bytes", size: 11 }),
    };
    const query = async (sql, values = []) => {
      if (sql === "begin") uuidLock = false;
      if (sql.includes('pg_advisory_xact_lock') && String(values[0]).startsWith('feedback-upload:')) uuidLock = true;
      if (sql.startsWith('select fingerprint')) return { rows: row && row.userId === values[1] && row.id === values[0] ? [row] : [] };
      if (sql.startsWith('select "id","email"')) return { rows: session?.user.emailVerified ? [session.user] : [] };
      if (sql.startsWith('select "id" from "user"')) return { rows: [{ id: values[0] }], rowCount: 1 };
      if (sql.includes('as retained')) return { rows: [{ retained: 0, bytes: "0" }] };
      if (sql.startsWith('select count')) return { rows: [{ count: String(count) }] };
      if (sql.startsWith('insert into')) { if (row?.id === values[0]) throw new Error("duplicate UUID"); row = { id: values[0], userId: values[1], fingerprint: values[2], attachments: JSON.parse(values[3]) }; }
      if (sql.startsWith('select "userId"')) return { rows: row ? [row] : [] };
      if (sql === "commit" && failCommit) throw new Error("connection lost at commit");
      if (sql === "commit") uuidLock = false;
      if (sql === "rollback") { row = null; uuidLock = false; }
      return { rows: [] };
    };
    mock.module("@/lib/db", () => ({ db: { query, connect: async () => ({ query, release() {} }) } }));
    mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => session } } }));
    mock.module("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: { FEEDBACK_IMAGES: bucket } }) }));
    const { storeAttachments } = await import("./lib/feedback/storage.ts");
    const png = new File([new Uint8Array([137,80,78,71,13,10,26,10])], "screen.png", { type: "image/png" });
    const id = "12345678-1234-4123-8123-123456789012";
    const first = await storeAttachments("owner", id, [png]);
    expect(await storeAttachments("owner", id, [png])).toEqual(first);
    expect(puts).toBe(1);
    await expect(storeAttachments("owner", id, [new File([await png.arrayBuffer()], "different.png", { type: "image/png" })])).rejects.toThrow("changed");
    row = null; count = 20;
    await expect(storeAttachments("owner", id, [png])).rejects.toThrow("Too many");
    expect(puts).toBe(1);
    count = 0; failPut = true;
    await expect(storeAttachments("owner", id, [png])).rejects.toThrow("R2 unavailable");
    expect(deletes).toBe(1);
    failPut = false; failCommit = true;
    await expect(storeAttachments("owner", id, [png])).rejects.toThrow("connection lost");
    expect(deletes).toBe(1);
    failCommit = false;
    await storeAttachments("owner", id, [png]);
    const writesBeforeCollision = puts;
    await expect(storeAttachments("other", id, [png])).rejects.toThrow("duplicate UUID");
    expect(puts).toBe(writesBeforeCollision);
    await storeAttachments("owner", id, [png]);
    const { GET } = await import("./app/api/feedback/attachments/[id]/[index]/route.ts");
    const request = new Request("https://app.example/api/feedback/attachments/" + id + "/0");
    const context = { params: Promise.resolve({ id, index: "0" }) };
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    session = { user: { id: "other", email: "reviewer@example.com", emailVerified: false } };
    process.env.FEEDBACK_REVIEWER_EMAILS = "reviewer@example.com";
    expect((await GET(request, context)).status).toBe(404);
    session.user.emailVerified = true;
    expect((await GET(request, context)).status).toBe(200);
    process.env.FEEDBACK_REVIEWER_EMAILS = "";
    expect((await GET(request, context)).status).toBe(404);
    session = null;
    const redirect = await GET(request, context);
    expect(redirect.status).toBe(302);
    expect(new URL(redirect.headers.get("location")).searchParams.get("next")).toBe(new URL(request.url).pathname);
    const { POST } = await import("./app/api/feedback/attachments/route.ts");
    process.env.BETTER_AUTH_URL = "https://app.example";
    expect((await POST(new Request("https://app.example/api", { method: "POST", headers: { Origin: "https://evil.example" } }))).status).toBe(403);
    expect((await POST(new Request("https://app.example/api", { method: "POST", headers: { Origin: "https://app.example" } }))).status).toBe(401);
    session = { user: { id: "owner", email: "owner@example.com", emailVerified: true } };
    const { MutationBudgetError } = await import("./lib/security/mutation-budget.ts");
    let budgetFailure = new MutationBudgetError(42), budgetCalls = 0;
    mock.module("@/lib/feedback/upload-budget", () => ({ reserveFeedbackUpload: async userId => {
      expect(userId).toBe("owner"); budgetCalls++; throw budgetFailure;
    } }));
    // A malformed body would yield 400 if it were parsed before admission.
    const denied = await POST(new Request("https://app.example/api", {
      method: "POST", headers: { Origin: "https://app.example" }, body: "invalid multipart",
    }));
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("42");
    expect(denied.headers.get("cache-control")).toBe("no-store");
    const putsBeforeUnavailable = puts;
    budgetFailure = new Error("Guard unavailable");
    expect((await POST(new Request("https://app.example/api", {
      method: "POST", headers: { Origin: "https://app.example" }, body: "invalid multipart",
    }))).status).toBe(503);
    expect(budgetCalls).toBe(2);
    expect(puts).toBe(putsBeforeUnavailable);
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
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  expect(new TextDecoder().decode(child.stdout)).toContain("PASS");
});
