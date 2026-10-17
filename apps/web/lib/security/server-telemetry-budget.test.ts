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
