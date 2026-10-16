import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test("workerd shares weighted budgets across callers and caches true readiness status", () => {
  // Miniflare requires Undici dispatchers, which Bun's built-in fetch ignores.
  const result = spawnSync(
    "node",
    [fileURLToPath(new URL("../../scripts/test-public-budget-worker.mjs", import.meta.url))],
    {
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 65_000);
