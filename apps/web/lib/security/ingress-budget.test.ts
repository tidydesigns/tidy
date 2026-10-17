import { expect, test } from "bun:test";
import { checkIngress, ingressKind } from "./ingress-budget";
import { budgetShard, type BudgetConsumer } from "./worker-budget";

test("ingress classifies encoded auth paths and isolates privacy, webhooks and telemetry", () => {
  for (const [path, kind] of [
    ["/api/auth/sign-up/email", "registration"],
    ["/api/auth/sign-up/%65mail/", "registration"],
    ["/.well-known/oauth-authorization-server/api/auth", "auth"],
    ["/api/privacy/consent", "privacy"],
    ["/api/privacy/cleanup", "cleanup"],
    ["/api/billing/webhook", "webhook"],
    ["/api/files/a/snapshot", "application"],
    ["/api/t/e", null],
    ["/api/health", null],
  ] as const)
    expect(ingressKind(new Request(`https://app.test${path}`))).toBe(kind);
});

test("shared exhaustion stops before allocating an identity counter; failures fail closed", async () => {
  const calls: string[] = [];
  const deny: BudgetConsumer = async (scope) => {
    calls.push(scope);
    return { allowed: false, retryAfter: 17 };
  };
  const response = await checkIngress(new Request("https://app.test/api/files/a/snapshot"), deny);
  expect(response?.status).toBe(429);
  expect(response?.headers.get("retry-after")).toBe("17");
  expect(calls).toEqual(["ingress:application"]);
  const unavailable = await checkIngress(new Request("https://app.test/login"), async () => {
    throw new Error("offline");
  });
  expect(unavailable?.status).toBe(503);
  expect(await unavailable?.text()).not.toContain("offline");
});

test("identity admission follows shared admission and does not use request IDs as object names", async () => {
  const scopes = new Set<string>();
  const allowed: BudgetConsumer = async (scope) => {
    scopes.add(scope);
    return { allowed: true, retryAfter: null };
  };
  for (let i = 0; i < 256; i++)
    expect(
      await checkIngress(
        new Request(`https://app.test/api/files/${i}/snapshot`, {
          headers: { "cf-connecting-ip": `192.0.2.${i}` },
        }),
        allowed,
      ),
    ).toBeNull();
  expect(scopes.size).toBeLessThanOrEqual(65);
  expect(await budgetShard("same-account")).toBe(await budgetShard("same-account"));
});
