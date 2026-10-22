import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthGuardStore } from "../auth/guard-store";
import { checkIngress, ingressKind, INGRESS_LIMITS } from "./ingress-budget";
import { budgetShard, type BudgetConsumer } from "./worker-budget";

function budgets() {
  const stores = new Map<string, { database: Database; guard: AuthGuardStore }>();
  const calls = new Map<string, number>();
  const consume: BudgetConsumer = async (scope, first, second) => {
    calls.set(scope, (calls.get(scope) ?? 0) + 1);
    let store = stores.get(scope);
    if (!store) {
      const database = new Database(":memory:");
      // The store only uses exec().toArray(); Bun SQLite supplies that subset.
      const sql = {
        exec<T extends Record<string, SqlStorageValue>>(
          query: string,
          ...bindings: (string | number | null)[]
        ) {
          const rows = database.prepare<T, (string | number | null)[]>(query).all(...bindings);
          return { toArray: () => rows };
        },
      } as SqlStorage;
      store = { database, guard: new AuthGuardStore(sql) };
      stores.set(scope, store);
    }
    return store.guard.consumePair(first, second);
  };
  return {
    consume,
    calls,
    [Symbol.dispose]() {
      for (const { database } of stores.values()) database.close();
    },
  };
}

function signup(ip: string) {
  return new Request("https://app.test/api/auth/sign-up/email", {
    method: "POST",
    headers: { "cf-connecting-ip": ip },
  });
}

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

test("IP rejection preserves its response and stops before charging shared capacity", async () => {
  const calls: string[] = [];
  const deny: BudgetConsumer = async (scope) => {
    calls.push(scope);
    return { allowed: false, retryAfter: 17 };
  };
  const response = await checkIngress(new Request("https://app.test/api/files/a/snapshot"), deny);
  expect(response?.status).toBe(429);
  expect(response?.headers.get("retry-after")).toBe("17");
  expect(response?.headers.get("cache-control")).toBe("private, no-store");
  expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
  expect(calls).toEqual([`ingress:application:ip:${await budgetShard("unknown")}`]);
});

test.each(["ip", "global"] as const)("%s guard failures fail closed", async (failure) => {
  const unavailable = await checkIngress(signup("192.0.2.1"), async (scope) => {
    if (failure === "ip" || scope === "ingress:registration") throw new Error("offline");
    return { allowed: true, retryAfter: null };
  });
  expect(unavailable?.status).toBe(503);
  expect(unavailable?.headers.get("retry-after")).toBe("5");
  expect(unavailable?.headers.get("cache-control")).toBe("private, no-store");
  const body: unknown = await unavailable?.json();
  expect(body).toEqual({
    error: "Temporarily unavailable. Try again shortly.",
  });
});

test("identity admission uses bounded shards and does not use request IDs as object names", async () => {
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

test("concurrent signup abuse cannot spend other IPs' shared minute allowance", async () => {
  using budget = budgets();
  const { minute, ipMinute } = INGRESS_LIMITS.registration;
  const responses = await Promise.all(
    Array.from({ length: minute }, () => checkIngress(signup("192.0.2.1"), budget.consume)),
  );
  expect(responses.filter((response) => response === null)).toHaveLength(ipMinute);
  expect(responses.filter((response) => response?.status === 429)).toHaveLength(minute - ipMinute);
  expect(budget.calls.get("ingress:registration")).toBe(ipMinute);

  const remaining = await Promise.all(
    Array.from({ length: minute - ipMinute }, (_, index) =>
      checkIngress(signup(`198.51.100.${index}`), budget.consume),
    ),
  );
  expect(remaining.every((response) => response === null)).toBe(true);
  const exhausted = await checkIngress(signup("203.0.113.1"), budget.consume);
  expect(exhausted?.status).toBe(429);
  expect(Number(exhausted?.headers.get("retry-after"))).toBeGreaterThan(0);
});

test.each([
  ["application", "/api/files/a/snapshot"],
  ["auth", "/api/auth/sign-in/email"],
  ["registration", "/api/auth/sign-up/email"],
  ["privacy", "/api/privacy/consent"],
  ["webhook", "/api/billing/webhook"],
  ["cleanup", "/api/privacy/cleanup"],
] as const)(
  "%s keeps its IP limit and admits another IP without charging rejected traffic",
  async (kind, path) => {
    using budget = budgets();
    const request = new Request(`https://app.test${path}`, {
      headers: { "cf-connecting-ip": "192.0.2.1" },
    });
    const { ipMinute } = INGRESS_LIMITS[kind];
    for (let index = 0; index < ipMinute; index++)
      expect(await checkIngress(request, budget.consume)).toBeNull();
    expect((await checkIngress(request, budget.consume))?.status).toBe(429);
    expect(budget.calls.get(`ingress:${kind}`)).toBe(ipMinute);
    expect(
      await checkIngress(
        new Request(request, { headers: { "cf-connecting-ip": "192.0.2.2" } }),
        budget.consume,
      ),
    ).toBeNull();
  },
);

test("hourly IP rejection preserves shared capacity and both windows recover on time", async () => {
  using budget = budgets();
  const clock = spyOn(Date, "now");
  const request = signup("192.0.2.1");
  const { ipMinute, ipHour, minute } = INGRESS_LIMITS.registration;
  try {
    for (let index = 0; index < ipHour; index++) {
      clock.mockReturnValue(1000 + Math.floor(index / ipMinute) * 60_000);
      expect(await checkIngress(request, budget.consume)).toBeNull();
    }
    clock.mockReturnValue(241_000);
    for (let index = 0; index < minute; index++)
      expect((await checkIngress(request, budget.consume))?.status).toBe(429);
    expect(budget.calls.get("ingress:registration")).toBe(ipHour);
    expect(await checkIngress(signup("192.0.2.2"), budget.consume)).toBeNull();
    clock.mockReturnValue(3_601_000);
    expect(await checkIngress(request, budget.consume)).toBeNull();
  } finally {
    clock.mockRestore();
  }
});

test("shared hourly exhaustion remains enforced across IPs and minute resets", async () => {
  using budget = budgets();
  const clock = spyOn(Date, "now");
  const { minute, hour } = INGRESS_LIMITS.registration;
  try {
    for (let index = 0; index < hour; index++) {
      clock.mockReturnValue(1000 + Math.floor(index / minute) * 60_000);
      const ip = `192.0.${Math.floor(index / 256)}.${index % 256}`;
      expect(await checkIngress(signup(ip), budget.consume)).toBeNull();
    }
    clock.mockReturnValue(1_021_000);
    const exhausted = await checkIngress(signup("198.51.100.1"), budget.consume);
    expect(exhausted?.status).toBe(429);
    expect(exhausted?.headers.get("retry-after")).toBe("2580");
    clock.mockReturnValue(3_601_000);
    expect(await checkIngress(signup("198.51.100.1"), budget.consume)).toBeNull();
  } finally {
    clock.mockRestore();
  }
});

test("missing IPs retain one fallback allowance despite changing forwarding headers", async () => {
  using budget = budgets();
  for (let index = 0; index <= INGRESS_LIMITS.registration.ipMinute; index++) {
    const response = await checkIngress(
      new Request("https://app.test/api/auth/sign-up/email", {
        headers: { "x-forwarded-for": `192.0.2.${index}` },
      }),
      budget.consume,
    );
    expect(response?.status ?? 204).toBe(index < INGRESS_LIMITS.registration.ipMinute ? 204 : 429);
  }
});

test.each(["/api/health", "/api/t", "/api/t/e"])(
  "%s retains its separate admission path",
  async (path) => {
    using budget = budgets();
    expect(await checkIngress(new Request(`https://app.test${path}`), budget.consume)).toBeNull();
    expect(budget.calls.size).toBe(0);
  },
);
