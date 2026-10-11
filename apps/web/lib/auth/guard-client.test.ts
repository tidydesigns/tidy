import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { consumeMutationRateLimit, consumeMutationRateLimitPair } from "./guard-client";
import type { RateCheck, RateDecision, RateRule } from "./guard-store";
import { consumeImageBudget } from "../design/image-budget";
import { MutationBudgetError } from "../security/mutation-budget";
import { runWithRequestSignal } from "../request-lifecycle";

const symbol = Symbol.for("__cloudflare-context__");
const globals = globalThis as unknown as Record<symbol, unknown>;
const previous = globals[symbol];
const secret = "guard-pair-local-test-secret-at-least-32-characters";
const digest = (value: string) => createHmac("sha256", secret).update(value).digest("hex");
type Call = { shard: string; key: string; rule: RateRule; next?: RateCheck };
function fixture(consume: (call: Call) => Promise<RateDecision & { batchSupported?: boolean }>) {
  const calls: Call[] = [];
  globals[symbol] = {
    env: {
      BETTER_AUTH_SECRET: secret,
      AUTH_GUARD: {
        idFromName: (name: string) => name,
        get: (shard: string) => ({
          consume: async (key: string, rule: RateRule, next?: RateCheck) => {
            const call = { shard, key, rule, next };
            calls.push(call);
            return consume(call);
          },
        }),
      },
    },
  };
  return calls;
}
afterEach(() => {
  globals[symbol] = previous;
});
const admitted = { allowed: true, retryAfter: null };
const reserve = () =>
  consumeImageBudget(
    "read",
    "private-user",
    "private-workspace",
    consumeMutationRateLimit,
    consumeMutationRateLimitPair,
  );

test("upgraded image guards make two RPCs with unchanged scope/key hashes and ceilings", async () => {
  const calls = fixture(async () => ({ ...admitted, batchSupported: true }));
  await reserve();
  expect(calls).toEqual([
    {
      shard: `mutations:${digest("application-mutations-v1:image-read-account:private-user")}`,
      key: digest("minute"),
      rule: { window: 60, max: 240 },
      next: { key: digest("hour"), rule: { window: 3600, max: 6000 } },
    },
    {
      shard: `mutations:${digest("application-mutations-v1:image-read-workspace:private-workspace")}`,
      key: digest("minute"),
      rule: { window: 60, max: 1200 },
      next: { key: digest("hour"), rule: { window: 3600, max: 30000 } },
    },
  ]);
  expect(JSON.stringify(calls)).not.toMatch(/private-user|private-workspace/);
});

test("legacy guards consume each counter once in its original order", async () => {
  const calls = fixture(async () => admitted);
  await reserve();
  expect(calls.map((call) => call.key)).toEqual([
    digest("minute"),
    digest("hour"),
    digest("minute"),
    digest("hour"),
  ]);
  expect(calls.map((call) => call.rule.max)).toEqual([240, 6000, 1200, 30000]);
});

test("mixed guard versions enforce both account and workspace checks", async () => {
  const calls = fixture(async (call) => ({
    ...admitted,
    ...(call.rule.max === 240 ? { batchSupported: true } : {}),
  }));
  await reserve();
  expect(calls.map((call) => call.rule.max)).toEqual([240, 1200, 30000]);
});

for (const legacy of [true, false]) {
  test(`${legacy ? "legacy" : "upgraded"} denial stops without fallback or workspace charges`, async () => {
    const calls = fixture(async () => ({
      allowed: false,
      retryAfter: 23,
      ...(!legacy ? { batchSupported: true } : {}),
    }));
    await expect(reserve()).rejects.toBeInstanceOf(MutationBudgetError);
    expect(calls).toHaveLength(1);
  });
}

test("a lost batch response is never replayed after counters may have been charged", async () => {
  const calls = fixture(async () => {
    throw new Error("connection lost after reservation");
  });
  await expect(reserve()).rejects.toThrow("connection lost");
  expect(calls).toHaveLength(1);
});

test("canceling an in-flight legacy call never dispatches its fallback", async () => {
  const controller = new AbortController();
  const calls = fixture(async () => {
    controller.abort(new Error("request deadline"));
    return admitted;
  });
  await expect(runWithRequestSignal(controller.signal, reserve)).rejects.toThrow(
    "request deadline",
  );
  expect(calls).toHaveLength(1);
});

test("already canceled requests dispatch no quota calls", async () => {
  const controller = new AbortController();
  const calls = fixture(async () => admitted);
  controller.abort(new Error("request ended"));
  await expect(runWithRequestSignal(controller.signal, reserve)).rejects.toThrow("request ended");
  expect(calls).toHaveLength(0);
});
