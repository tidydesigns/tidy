import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("checkout retry reuses its idempotency key, then reuses the persisted open session", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock, expect } from "bun:test";
    globalThis.fetch = async () => { throw Error("Unexpected outbound request"); };
    mock.module("server-only", () => ({}));
    let denied = false, failUpdate = true, snapshot;
    let catalogCalls = 0, creates = 0, remoteSessions = 0;
    const keys = [], sessions = new Map();
    const row = { stripeCustomerId: "customer", stripeSubscriptionId: null, stripeCheckoutSessionId: null, stripeStatus: null, firstMonthUsed: false };
    const query = async (sql, values) => {
      if (sql === "begin") snapshot = { ...row };
      if (sql === "rollback") Object.assign(row, snapshot);
      if (/^select "id" from "(organization|user|member)"/.test(sql)) return { rows: [{ id: "authorized" }], rowCount: 1 };
      if (sql.startsWith('select * from')) return { rows: [{ ...row }] };
      if (sql.startsWith('update "organization_billing"')) {
        if (failUpdate) throw Error("Database update unavailable");
        row.stripeCustomerId = values[1]; row.stripeCheckoutSessionId = values[2];
      }
      return { rows: [] };
    };
    mock.module("@/lib/db", () => ({ db: { connect: async () => ({ query, release() {} }) } }));
    mock.module("@/lib/organizations/authorization", () => ({ OrganizationAccessError: class extends Error {}, requireOrganizationPermission: async () => {} }));
    mock.module("@/lib/security/operation-budget", () => ({ reserveOperation: async () => { if (denied) throw Error("Budget exhausted"); }, reserveWorkspaceOperation: async () => {} }));
    mock.module("@/lib/billing/plan-server", () => ({ organizationPlanTier: async () => "free", requireRegisteredProPrice: async () => {}, organizationPlanUsage: async () => ({}), proPlanLimits: async () => ({}) }));
    const check = options => { expect(options.maxNetworkRetries).toBe(0); expect(options.timeout).toBeGreaterThan(0); expect(options.timeout).toBeLessThanOrEqual(5000); };
    mock.module("stripe", () => ({ default: class {
      static createFetchHttpClient() { return {}; }
      constructor(_key, options) { check(options); }
      prices = { retrieve: async (_id, _params, options) => { check(options); catalogCalls++; return { active: true, currency: "usd", unit_amount: 1000, recurring: { interval: "month", interval_count: 1 }, product: "product" }; } };
      coupons = { retrieve: async (_id, _params, options) => { check(options); catalogCalls++; return { valid: true, amount_off: 500, currency: "usd", duration: "once" }; } };
      subscriptions = { list: async (_params, options) => { check(options); return { data: [], has_more: false }; } };
      checkout = { sessions: {
        retrieve: async (id, _params, options) => { check(options); return { id, status: "open", url: "https://checkout.test/open" }; },
        create: async (_params, options) => {
          check(options); creates++; keys.push(options.idempotencyKey);
          if (!sessions.has(options.idempotencyKey)) { remoteSessions++; sessions.set(options.idempotencyKey, { id: "checkout-session", url: "https://checkout.test/open" }); }
          return sessions.get(options.idempotencyKey);
        },
      } };
    } }));
    Object.assign(process.env, { STRIPE_SECRET_KEY: "fixture", STRIPE_WEBHOOK_SECRET: "fixture", STRIPE_PRO_PRICE_ID: "price_pro", STRIPE_FIRST_MONTH_COUPON_ID: "coupon_intro", BETTER_AUTH_URL: "https://app.test" });
    const { checkoutUrl } = await import("./lib/billing/server.ts");
    denied = true;
    await expect(checkoutUrl("owner", "workspace", "fixture@example.test")).rejects.toThrow("Budget exhausted");
    expect(catalogCalls).toBe(0);
    denied = false;
    await expect(checkoutUrl("owner", "workspace", "fixture@example.test")).rejects.toThrow("Database update unavailable");
    expect(row.stripeCheckoutSessionId).toBeNull();
    failUpdate = false;
    expect(await checkoutUrl("owner", "workspace", "fixture@example.test")).toBe("https://checkout.test/open");
    expect(keys[0]).toBe(keys[1]); expect(remoteSessions).toBe(1);
    const catalogBefore = catalogCalls;
    expect(await checkoutUrl("owner", "workspace", "fixture@example.test")).toBe("https://checkout.test/open");
    expect(creates).toBe(2); expect(catalogCalls).toBe(catalogBefore);
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
