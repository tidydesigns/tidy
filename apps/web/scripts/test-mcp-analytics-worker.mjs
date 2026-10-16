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
        builder.onResolve({ filter: /^@\/lib\/privacy\/(?:mcp-consent|mcp-retention)$/ }, () => ({
          path: "consent",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `export const mcpMonitoringId = date => 'mcp:service:' + date.toISOString().slice(0,10);
        export async function queueMcpMonitoringErasure() { throw new Error('No database in this fixture'); }
        export const mcpAnalyticsId = id => 'mcp:' + id;
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
        const clients = {
          success: { name: 'codex-mcp-client', version: 'v0.160.0' },
          failed: { name: 'claude-code', version: '2.1.0' },
          unlinked: { name: 'opencode', version: '1.2.3' },
          custom: { name: 'PRIVATE CLIENT', version: 'PRIVATE VERSION' }
        };
        await sendMcpMetric(id === 'unlinked' ? undefined : id, { tool: 'get_file', timestamp: new Date('2026-10-16T12:34:56.789Z'), durationMs: 42, failed: id === 'failed', client: clients[id] }, {
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
    ["success", "failed", "unlinked", "custom"].map((id) =>
      worker.dispatchFetch(`https://mcp.test/${id}`),
    ),
  );
  for (const response of responses) assert.equal(await response.text(), "ok");
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((event) => event.distinct_id).sort(), [
    "mcp:custom",
    "mcp:failed",
    "mcp:service:2026-10-16",
    "mcp:success",
  ]);
  for (const event of events) {
    assert.equal(event.event, "$mcp_tool_call");
    assert.equal(event.properties.$mcp_tool_name, "get_file");
    assert.equal(event.properties.$mcp_is_error, event.distinct_id === "mcp:failed");
    assert.equal(
      event.properties.$mcp_account_linked,
      !event.distinct_id.startsWith("mcp:service:"),
    );
    assert.equal(event.properties.$process_person_profile, false);
    assert.equal(event.properties.$geoip_disable, true);
    const expected = {
      "mcp:success": ["codex", "0.160.0"],
      "mcp:failed": ["claude_code", "2.1.0"],
      "mcp:service:2026-10-16": ["opencode", "1.2.3"],
      "mcp:custom": ["other", undefined],
    }[event.distinct_id];
    assert.equal(event.properties.$mcp_client_name, expected[0]);
    assert.equal(event.properties.$mcp_client_version, expected[1]);
    assert.doesNotMatch(
      JSON.stringify(event),
      /\$exception|\$mcp_parameters|\$mcp_response|\$set|\$session_id|PRIVATE/,
    );
  }
  console.log("MCP metadata delivery passed in workerd with isolated concurrent requests.");
} finally {
  await worker.dispose();
}
