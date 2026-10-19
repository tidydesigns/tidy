import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("scheduled billing endpoint validates its own credential before admission or database work", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { expect, mock } from "bun:test";
    let calls = 0, reservations = 0, failed = 0;
    mock.module("@/lib/billing/reconciliation", () => ({ reconcileBilling: async () => { calls++; return { checked: 1, failed }; } }));
    mock.module("@/lib/security/operation-budget", () => ({ operationBudgetResponse: async () => { reservations++; return null; } }));
    const { POST } = await import("./app/api/internal/billing/reconcile/route.ts");
    const secret = "fixture-billing-reconciliation-secret-at-least-32-characters";
    const invoke = token => POST(new Request("https://app.test/api/internal/billing/reconcile", { method: "POST", headers: token ? { authorization: "Bearer " + token } : {} }));
    delete process.env.BILLING_RECONCILIATION_SECRET;
    expect((await invoke(secret)).status).toBe(401);
    process.env.BILLING_RECONCILIATION_SECRET = secret;
    expect((await invoke()).status).toBe(401);
    expect((await invoke("different")).status).toBe(401);
    expect(calls).toBe(0); expect(reservations).toBe(0);
    const response = await invoke(secret);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(calls).toBe(1); expect(reservations).toBe(1);
    failed = 1;
    expect((await invoke(secret)).status).toBe(503);
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
