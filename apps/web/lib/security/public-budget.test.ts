import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthGuardStore, type RateCheck } from "../auth/guard-store";
import { consumeTelemetryBytes, PublicBudgetError } from "./public-budget";

test("receipt hourly byte usage survives minute resets, isolates other receipts and expires", async () => {
  let now = 1000;
  const database = new Database(":memory:");
  const guard = new AuthGuardStore({
    exec(query: string, ...bindings: (string | number | null)[]) {
      const rows = database.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage);
  const consume = async (scope: string, first: RateCheck, second: RateCheck) => {
    const result = guard.consume(`${scope}:${first.key}`, first.rule, now);
    return result.allowed ? guard.consume(`${scope}:${second.key}`, second.rule, now) : result;
  };
  try {
    for (let minute = 0; minute < 10; minute++) {
      for (let i = 0; i < 4; i++) await consumeTelemetryBytes("one", 5_000_000, consume);
      now += 60_001;
    }
    await expect(consumeTelemetryBytes("one", 1, consume)).rejects.toBeInstanceOf(
      PublicBudgetError,
    );
    await consumeTelemetryBytes("another", 5_000_000, consume);
    now += 3_600_001;
    await consumeTelemetryBytes("one", 5_000_000, consume);
    for (const bytes of [-1, NaN, Infinity, 5_000_001])
      await expect(consumeTelemetryBytes("invalid", bytes, consume)).rejects.toBeInstanceOf(
        PublicBudgetError,
      );
  } finally {
    database.close();
  }
});

test("empty requests consume a minimum byte charge and unavailable guards fail closed", async () => {
  const checks: RateCheck[] = [];
  await consumeTelemetryBytes("one", 0, async (_scope, first, second) => {
    checks.push(first, second);
    return { allowed: true, retryAfter: null };
  });
  expect(checks).toHaveLength(4);
  expect(checks.every((check) => check.rule.cost === 65_536)).toBe(true);
  await expect(
    consumeTelemetryBytes("one", 1, async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
});
