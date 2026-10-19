import { expect, test } from "bun:test";
import { consumeServerTelemetry } from "./server-telemetry-budget";

test("duplicate suppression preserves global capacity for unrelated errors", async () => {
  const calls: string[] = [];
  expect(
    await consumeServerTelemetry("errors", "known-error", async (scope) => {
      calls.push(scope);
      return { allowed: false, retryAfter: 60 };
    }),
  ).toBe(false);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toStartWith("server-errors:");
  expect(
    await consumeServerTelemetry("flags", "global", async () => {
      throw new Error("offline");
    }),
  ).toBe(false);
});

test("trace admission prepays ordinary and stalled exports against one global ceiling", async () => {
  let used = 0;
  for (let i = 0; i < 11; i++) {
    expect(
      await consumeServerTelemetry("traces", "ignored", async (scope, first, second) => {
        expect(scope).toBe("server-traces");
        expect(first.rule).toEqual({ window: 60, max: 20, cost: 2 });
        expect(second.rule).toEqual({ window: 3600, max: 200, cost: 2 });
        used += first.rule.cost!;
        return { allowed: used <= first.rule.max, retryAfter: 60 };
      }),
    ).toBe(i < 10);
  }
});
