import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthGuardStore } from "./guard-store";
import { authRateLimitKey } from "./rate-limit-key";

test("default endpoint paths share bounded counters and leave other identities available", async () => {
  const database = new Database(":memory:");
  const guard = new AuthGuardStore({
    exec(query: string, ...bindings: (string | number | null)[]) {
      const rows = database.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage);
  try {
    let admitted = 0;
    for (let i = 0; i < 10_001; i++) {
      const counter = await authRateLimitKey(`203.0.113.10|/endpoint-${i}`, {
        window: 60,
        max: 120,
      });
      if (guard.consume(counter.key, { window: 60, max: 120 }, 1000).allowed) admitted++;
    }
    expect(admitted).toBe(120);
    expect(database.query("select count(*) as count from auth_bucket").get()).toEqual({ count: 1 });
    const other = await authRateLimitKey("198.51.100.20|/sign-in/email", { window: 60, max: 10 });
    expect(guard.consume(other.key, { window: 60, max: 10 }, 1000).allowed).toBe(true);
  } finally {
    database.close();
  }
});

test("explicit endpoint rules remain distinct and shard names contain no identities", async () => {
  const rule = { window: 60, max: 120 };
  const signin = await authRateLimitKey("203.0.113.10|/sign-in/email", rule);
  const signup = await authRateLimitKey("203.0.113.10|/sign-up/email", rule);
  const discovery = await authRateLimitKey("203.0.113.10|/get-session", rule);
  const sensitive = await authRateLimitKey("203.0.113.10|/change-password", { window: 10, max: 3 });
  expect(signin.scope).toBe(signup.scope);
  expect(signin.key).not.toBe(signup.key);
  expect(signin.key).not.toBe(discovery.key);
  expect(sensitive.key).not.toBe(discovery.key);
  expect(signin.scope).toMatch(/^auth-endpoints-v2:\d+$/);
  await expect(authRateLimitKey("unstructured", rule)).rejects.toThrow();
});
