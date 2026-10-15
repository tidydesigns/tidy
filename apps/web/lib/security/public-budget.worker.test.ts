import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use the installed Wrangler's matching workerd, with no production bindings.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
test("workerd shares weighted budgets across callers and caches true readiness status", async () => {
  const build = await Bun.build({
    entrypoints: [
      new URL("../../scripts/fixtures/public-budget-worker.ts", import.meta.url).pathname,
    ],
    target: "browser",
    external: ["cloudflare:workers", "node:*"],
  });
  if (!build.success) throw new AggregateError(build.logs, "Fixture build failed");
  const directory = await mkdtemp(join(tmpdir(), "tidy-public-budget-"));
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      resourcePersistencePath: directory,
      modules: true,
      script: await build.outputs[0]!.text(),
      compatibilityDate: "2026-09-26",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      bindings: { BETTER_AUTH_SECRET: "local-public-budget-fixture-secret-at-least-32-characters" },
      durableObjects: { AUTH_GUARD: { className: "AuthGuard", useSQLite: true } },
    }),
  );
  try {
    await worker.ready;
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        worker.dispatchFetch("https://public.test/bytes?bytes=5000000"),
      ),
    );
    expect(outcomes.filter((r: Response) => r.status === 204)).toHaveLength(4);
    expect(outcomes.filter((r: Response) => r.status === 429)).toHaveLength(4);
    // Rotating receipts cannot bypass the shared byte ceiling.
    const global = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        worker.dispatchFetch(`https://public.test/bytes?bytes=5000000&receipt=other-${i}`),
      ),
    );
    expect(global.filter((r: Response) => r.status === 204)).toHaveLength(92);
    expect(global.filter((r: Response) => r.status === 429)).toHaveLength(8);
    // A denied global budget must not allocate objects for new receipts.
    const before = (await worker.listDurableObjectIds("AuthGuard")).length;
    expect(before).toBeGreaterThan(1);
    for (let i = 0; i < 10; i++)
      expect(
        (await worker.dispatchFetch(`https://public.test/bytes?bytes=5000000&receipt=denied-${i}`))
          .status,
      ).toBe(429);
    expect((await worker.listDurableObjectIds("AuthGuard")).length).toBe(before);
    const identities = await Promise.all(
      Array.from({ length: 256 }, (_, i) =>
        worker.dispatchFetch("https://public.test/attempt", {
          headers: { "cf-connecting-ip": `198.51.100.${i}` },
        }),
      ),
    );
    expect(identities.every((r: Response) => r.status === 204)).toBe(true);
    const flood = await Promise.all(
      Array.from({ length: 605 }, () =>
        worker.dispatchFetch("https://public.test/attempt", {
          headers: { "cf-connecting-ip": "192.0.2.1" },
        }),
      ),
    );
    expect(flood.filter((r: Response) => r.status === 204)).toHaveLength(600);
    expect(flood.filter((r: Response) => r.status === 429)).toHaveLength(5);
    expect(
      (
        await worker.dispatchFetch("https://public.test/attempt", {
          headers: { "cf-connecting-ip": "192.0.2.2" },
        })
      ).status,
    ).toBe(204);
    for (const [suffix, expected, count] of [
      ["", 200, "1"],
      ["&fail=1", 503, "2"],
    ] as const) {
      for (let i = 0; i < 3; i++) {
        const response = await worker.dispatchFetch(
          `https://public.test/health?noise=${i}${suffix}`,
        );
        expect(response.status).toBe(expected);
        expect(response.headers.get("x-test-checks")).toBe(count);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
    // 64 IP shards + 64 receipt shards + three fixed shared guards.
    expect((await worker.listDurableObjectIds("AuthGuard")).length).toBeLessThanOrEqual(131);
    // Health admission has its own shard and is unaffected by telemetry exhaustion.
    expect((await worker.dispatchFetch("https://public.test/health?noise=last")).status).toBe(200);
  } finally {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
