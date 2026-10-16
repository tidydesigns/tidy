import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");
const bundle = await build({
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["node:*", "cloudflare:workers"],
  alias: { path: "node:path" },
  plugins: [
    {
      name: "isolated-mcp-consent",
      setup(builder) {
        builder.onResolve({ filter: /^server-only$/ }, () => ({
          path: "marker",
          namespace: "fixture",
        }));
        // Database consent enforcement is exercised by test:privacy:db. This test
        // checks the real SDK transport and simultaneous Worker invocations only.
        builder.onResolve({ filter: /^@\/lib\/privacy\/mcp-consent$/ }, () => ({
          path: "consent",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `export const mcpAnalyticsId = id => 'mcp:' + id;
        export async function activeMcpConsent() { throw new Error('No database in this fixture'); }
        export async function withMcpConsent() { throw new Error('No database in this fixture'); }`,
          loader: "js",
        }));
      },
    },
  ],
  stdin: {
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    contents: `import { sendMcpMetric } from './lib/mcp/analytics.ts';
      export default { async fetch(request) {
        const id = new URL(request.url).pathname.slice(1);
        await sendMcpMetric(id, { tool: 'get_file', timestamp: new Date(), durationMs: 42, failed: id === 'failed' }, {
          enabled: '1', key: 'synthetic-project', host: 'https://posthog.invalid', release: 'test-worker'
        });
        return new Response('ok');
      }};`,
    loader: "ts",
  },
});
const events = [];
const worker = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-09-26",
    compatibilityFlags: ["nodejs_compat"],
    outboundService: async (request) => {
      assert.equal(new URL(request.url).hostname, "posthog.invalid");
      const bytes = Buffer.from(await request.arrayBuffer());
      const body = JSON.parse((bytes[0] === 0x1f ? gunzipSync(bytes) : bytes).toString());
      events.push(...(body.batch ?? [body]));
      return Response.json({ status: 1 });
    },
  }),
);
try {
  await worker.ready;
  const responses = await Promise.all(
    ["success", "failed"].map((id) => worker.dispatchFetch(`https://mcp.test/${id}`)),
  );
  for (const response of responses) assert.equal(await response.text(), "ok");
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.distinct_id).sort(), ["mcp:failed", "mcp:success"]);
  for (const event of events) {
    assert.equal(event.event, "$mcp_tool_call");
    assert.equal(event.properties.$mcp_tool_name, "get_file");
    assert.equal(event.properties.$mcp_is_error, event.distinct_id === "mcp:failed");
    assert.equal(event.properties.$process_person_profile, false);
    assert.equal(event.properties.$geoip_disable, true);
    assert.doesNotMatch(
      JSON.stringify(event),
      /\$exception|\$mcp_parameters|\$mcp_response|\$set|\$session_id/,
    );
  }
  console.log("MCP metadata delivery passed in workerd with isolated concurrent requests.");
} finally {
  await worker.dispose();
}
