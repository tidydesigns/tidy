import { buildWorkerFixture } from "./fixtures/build-worker.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Wrangler's workerd version, with no production bindings or secrets.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const fixture = fileURLToPath(new URL("./fixtures/request-worker.ts", import.meta.url));
const build = await buildWorkerFixture({
  entrypoints: [fixture],
  target: "browser",
  external: ["cloudflare:workers", "node:*"],
  minify: false,
});
if (!build.success) throw new AggregateError(build.logs, "Worker fixture build failed");
const worker = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: await build.outputs[0].text(),
    compatibilityDate: "2026-09-26",
    compatibilityFlags: ["nodejs_compat"],
  }),
);
try {
  await worker.ready;
  const response = await worker.dispatchFetch("https://request.test/stall", {
    headers: { accept: "text/html" },
  });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Try again/);
  const bodyStarted = performance.now();
  const body = await worker.dispatchFetch("https://request.test/body-stall", {
    headers: { Connection: "close" },
  });
  // workerd may finish HTTP with partial content or abort the socket. Verify the
  // actual invariant inside the Worker too: the source is canceled on deadline.
  try {
    await body.text();
  } catch {
    /* interrupted stream */
  }
  assert(performance.now() - bodyStarted < 2000, "Page body escaped its deadline.");
  const sse = await worker.dispatchFetch("https://request.test/sse");
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(await sse.text(), "data: ready\n\n");
  assert.deepEqual(await (await worker.dispatchFetch("https://request.test/healthy")).json(), {
    active: true,
    canceled: true,
  });
  console.log(
    "PASS: workerd bounds handlers and finite page streams, preserves SSE, and isolates later requests",
  );
} finally {
  await worker.dispose();
}
