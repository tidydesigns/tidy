import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

// Exercise the edge SDK in workerd, with separately compiled route and Worker
// modules. Wrangler already provides the local runtime and bundler dependencies.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");
const workspace = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "tidy-tracing-runtime-"));
const payloads = [];
let runtime;
try {
  const options = {
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*", "./route-bundle.mjs"],
  };
  await build({
    ...options,
    outfile: path.join(directory, "route-bundle.mjs"),
    stdin: {
      resolveDir: workspace,
      contents: `
      import { traceOperation } from "./lib/trace-context.ts";
      import { tracedDatabaseClient } from "./lib/traced-database-client.ts";
      import { requestDatabaseClient } from "./lib/request-database-client.ts";
      export async function route(request) {
        return traceOperation("auth.api", async () => {
          if (new URL(request.url).pathname === "/stall") return new Promise(() => {});
          if (new URL(request.url).pathname === "/body-stall") return new Response(new ReadableStream(), {
            headers: { "content-type": "text/html" },
          });
          await Promise.resolve();
          const client = requestDatabaseClient(tracedDatabaseClient({ query: async () => {
            await Promise.resolve(); return { rows: [] };
          }, release() {} }));
          await client.query("private SQL", ["private token"]);
          return new Response("ok");
        });
      }
    `,
    },
  });
  await build({
    ...options,
    outfile: path.join(directory, "worker.mjs"),
    stdin: {
      resolveDir: workspace,
      contents: `
      import { observeRequest } from "./lib/request-observability.ts";
      import { handleRequest } from "./lib/request-boundary.ts";
      import { route } from "./route-bundle.mjs";
      export default { fetch(request, env, ctx) {
        return observeRequest(request, () => handleRequest(request, route, 50), undefined, {
          key: "runtime-test-key", host: "https://posthog.invalid", release: "runtime-test",
          waitUntil: task => ctx.waitUntil(task),
        });
      } };
    `,
    },
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modulesRoot: directory,
      modules: await Promise.all(
        ["worker.mjs", "route-bundle.mjs"].map(async (name) => ({
          type: "ESModule",
          path: path.join(directory, name),
          contents: await readFile(path.join(directory, name), "utf8"),
        })),
      ),
      compatibilityDate: "2026-09-26",
      compatibilityFlags: ["nodejs_compat"],
      outboundService: async (request) => {
        assert.equal(new URL(request.url).hostname, "posthog.invalid");
        const bytes = Buffer.from(await request.arrayBuffer());
        payloads.push(
          JSON.parse((bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes) : bytes).toString()),
        );
        return new Response('{"status":1}');
      },
    }),
  );
  const responses = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      runtime.dispatchFetch("https://app.test/api/mcp", { headers: { "cf-ray": `ray-${index}` } }),
    ),
  );
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  }
  const spans = () =>
    payloads.flatMap((payload) =>
      payload.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
  const deadline = Date.now() + 5000;
  while (spans().length < 20 && Date.now() < deadline) await delay(50);
  const exported = spans();
  assert.equal(exported.length, 20, "five requests should export four spans each");
  const roots = exported.filter((span) => span.name === "GET /api/mcp");
  assert.equal(
    new Set(roots.map((span) => span.traceId)).size,
    5,
    "requests must have separate traces",
  );
  for (const root of roots) {
    const children = exported.filter((span) => span.traceId === root.traceId);
    const routing = children.find((span) => span.name === "worker.routing");
    const auth = children.find((span) => span.name === "auth.api");
    const query = children.find((span) => span.name === "database.query");
    assert.equal(routing.parentSpanId, root.spanId);
    assert.equal(auth.parentSpanId, routing.spanId);
    assert.equal(query.parentSpanId, auth.spanId);
  }
  assert.doesNotMatch(JSON.stringify(payloads), /private SQL|private token/);
  const timeout = await runtime.dispatchFetch("https://app.test/stall");
  assert.equal(timeout.status, 503);
  await timeout.text();
  const timeoutDeadline = Date.now() + 5000;
  while (spans().length < 23 && Date.now() < timeoutDeadline) await delay(50);
  const timeoutRoot = spans().find((span) => span.name === "GET /:id");
  assert.equal(timeoutRoot.status.code, 2);
  assert.equal(
    timeoutRoot.attributes.find((attribute) => attribute.key === "http.response.status_code").value
      .intValue,
    "503",
  );
  const bodyTimeout = await runtime.dispatchFetch("https://app.test/body-stall", {
    headers: { "cf-ray": "body-timeout-ray" },
  });
  // The HTTP bridge can expose a failed empty stream as EOF. Assert the Worker
  // trace's body-failure outcome rather than a particular client-side error.
  await bodyTimeout.text().catch(() => {});
  const bodyDeadline = Date.now() + 5000;
  while (spans().length < 27 && Date.now() < bodyDeadline) await delay(50);
  const bodyRoot = spans().find((span) =>
    span.attributes?.some(
      (attribute) =>
        attribute.key === "cf_ray" && attribute.value.stringValue === "body-timeout-ray",
    ),
  );
  assert.equal(bodyRoot.status.code, 2);
  assert.equal(
    bodyRoot.attributes.find((attribute) => attribute.key === "app.request_outcome").value
      .stringValue,
    "response_body_failed",
  );
  console.info(
    "Worker tracing smoke test passed: five isolated traces retain parent spans across separate bundles; handler and HTML-body deadlines remain bounded and traced.",
  );
} finally {
  await runtime?.dispose();
  await rm(directory, { recursive: true, force: true });
}
