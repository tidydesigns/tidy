import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("billing attempts are shared across routes and rejected before reading a denied body", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock, expect } from "bun:test";
    let remaining = 2, providerCalls = 0;
    mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => ({ user: { id: "account", email: "fixture@example.test" } }) } } }));
    mock.module("@/lib/security/operation-budget", () => ({
      operationFailure: () => null,
      operationBudgetResponse: async (kind, user) => {
        expect(kind).toBe("billing-request"); expect(user).toBe("account");
        return remaining-- > 0 ? null : new Response(null, { status: 429, headers: { "Retry-After": "60", "Cache-Control": "private, no-store" } });
      },
    }));
    mock.module("@/lib/billing/server", () => ({ checkoutUrl: async () => { providerCalls++; return "https://checkout.test"; }, portalUrl: async () => { providerCalls++; return "https://portal.test"; } }));
    const checkout = (await import("./app/api/billing/checkout/route.ts")).POST;
    const portal = (await import("./app/api/billing/portal/route.ts")).POST;
    process.env.BETTER_AUTH_URL = "https://app.test";
    const request = body => new Request("https://app.test/api/billing", { method: "POST", headers: { origin: "https://app.test", "Content-Type": "application/json" }, body });
    expect((await checkout(request('{"organizationId":"workspace"}'))).status).toBe(200);
    expect((await portal(request('{"organizationId":"workspace"}'))).status).toBe(200);
    const denied = request("not valid JSON");
    const result = await checkout(denied);
    expect(result.status).toBe(429); expect(result.headers.get("retry-after")).toBe("60");
    expect(denied.bodyUsed).toBe(false); expect(providerCalls).toBe(2);
    remaining = 1;
    const oversized = request("x".repeat(65_537));
    expect((await portal(oversized)).status).toBe(413);
    expect(providerCalls).toBe(2);
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
