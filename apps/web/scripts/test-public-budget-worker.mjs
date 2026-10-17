import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { buildWorkerFixture } from "./fixtures/build-worker.mjs";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use the installed Wrangler's matching workerd, with no production bindings.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
{
  const build = await buildWorkerFixture({
    entrypoints: [fileURLToPath(new URL("./fixtures/public-budget-worker.ts", import.meta.url))],
    target: "browser",
    external: ["cloudflare:workers", "node:*"],
  });
  if (!build.success) throw new AggregateError(build.logs, "Fixture build failed");
  const directory = await mkdtemp(join(tmpdir(), "tidy-public-budget-"));
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      resourcePersistencePath: directory,
      modules: true,
      script: await build.outputs[0].text(),
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
    assert.equal(outcomes.filter((r) => r.status === 204).length, 4);
    assert.equal(outcomes.filter((r) => r.status === 429).length, 4);
    // Rotating receipts cannot bypass the shared byte ceiling.
    const global = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        worker.dispatchFetch(`https://public.test/bytes?bytes=5000000&receipt=other-${i}`),
      ),
    );
    assert.equal(global.filter((r) => r.status === 204).length, 92);
    assert.equal(global.filter((r) => r.status === 429).length, 8);
    // A denied global budget must not allocate objects for new receipts.
    const before = (await worker.listDurableObjectIds("AuthGuard")).length;
    assert(before > 1);
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await worker.dispatchFetch(`https://public.test/bytes?bytes=5000000&receipt=denied-${i}`))
          .status,
        429,
      );
    assert.equal((await worker.listDurableObjectIds("AuthGuard")).length, before);
    const identities = await Promise.all(
      Array.from({ length: 256 }, (_, i) =>
        worker.dispatchFetch("https://public.test/attempt", {
          headers: { "cf-connecting-ip": `198.51.100.${i}` },
        }),
      ),
    );
    assert.equal(
      identities.every((r) => r.status === 204),
      true,
    );
    const flood = await Promise.all(
      Array.from({ length: 605 }, () =>
        worker.dispatchFetch("https://public.test/attempt", {
          headers: { "cf-connecting-ip": "192.0.2.1" },
        }),
      ),
    );
    assert.equal(flood.filter((r) => r.status === 204).length, 600);
    assert.equal(flood.filter((r) => r.status === 429).length, 5);
    assert.equal(
      (
        await worker.dispatchFetch("https://public.test/attempt", {
          headers: { "cf-connecting-ip": "192.0.2.2" },
        })
      ).status,
      204,
    );
    for (const [suffix, expected, count] of [
      ["", 200, "1"],
      ["&fail=1", 503, "2"],
    ]) {
      for (let i = 0; i < 3; i++) {
        const response = await worker.dispatchFetch(
          `https://public.test/health?noise=${i}${suffix}`,
        );
        assert.equal(response.status, expected);
        assert.equal(response.headers.get("x-test-checks"), count);
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
    }
    // 64 IP shards + 64 receipt shards + three fixed shared guards.
    assert((await worker.listDurableObjectIds("AuthGuard")).length <= 131);
    // Health admission has its own shard and is unaffected by telemetry exhaustion.
    assert.equal((await worker.dispatchFetch("https://public.test/health?noise=last")).status, 200);
    // Outer admission works before OpenNext has installed any request context.
    const registration = await Promise.all(
      Array.from({ length: 6 }, () =>
        worker.dispatchFetch("https://public.test/ingress/api/auth/sign-up/email", {
          headers: { "cf-connecting-ip": "203.0.113.1" },
        }),
      ),
    );
    assert.equal(registration.filter((r) => r.status === 204).length, 5);
    assert.equal(registration.filter((r) => r.status === 429).length, 1);
    assert.equal(registration.find((r) => r.status === 429).headers.has("x-test-admitted"), false);
    const connections = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        worker.dispatchFetch(`https://public.test/lease?id=${i}`),
      ),
    );
    assert.equal(connections.filter((r) => r.status === 204).length, 10);
    assert.equal(connections.filter((r) => r.status === 429).length, 10);
  } finally {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}
