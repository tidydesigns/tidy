import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("feedback validates JSON before storage and retains authorization, limits, and trimming", () => {
  // Isolate service stubs so the wider suite retains real auth and storage modules.
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock, expect } from "bun:test";
    mock.module("server-only", () => ({}));
    let verified = true, stored = [];
    process.env.BETTER_AUTH_URL = "https://app.example";
    mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => ({ user: { id: "user", emailVerified: verified } }) } } }));
    mock.module("@/lib/security/personal-budget", () => ({ reservePersonalAttempts: async () => {}, PersonalBudgetError: class extends Error {} }));
    mock.module("@/lib/feedback/submissions", () => ({ storeFeedback: async (...args) => stored.push(args) }));
    const { POST } = await import("./app/api/feedback/route.ts");
    const send = (body, origin = "https://app.example") => POST(new Request("https://app.example/api/feedback", { method: "POST", headers: { origin }, body }));
    const valid = { id: "12345678-1234-4123-8123-123456789012", category: "general", message: "  useful feedback  " };
    for (const body of ["null", "[]", "42", "invalid", "{}", JSON.stringify({ ...valid, message: " " }), JSON.stringify({ ...valid, message: " " + "x".repeat(10000) })])
      expect((await send(body)).status).toBe(400);
    expect(stored).toHaveLength(0);
    expect((await send(JSON.stringify(valid), "https://other.example")).status).toBe(403);
    verified = false;
    expect((await send(JSON.stringify(valid))).status).toBe(401);
    verified = true;
    expect((await send("x".repeat(50001))).status).toBe(413);
    expect((await send(JSON.stringify(valid))).status).toBe(200);
    expect(stored).toEqual([["user", valid.id, "general", "useful feedback"]]);
  `,
    ],
    { cwd: resolve(import.meta.dir, "../../.."), env: process.env },
  );
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
});
