import "server-only";
import { PostHogMCP } from "@posthog/mcp";
import type { McpServer } from "@modelcontextprotocol/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { activeMcpConsent, mcpAnalyticsId, withMcpConsent } from "@/lib/privacy/mcp-consent";
import { runWithRequestSignal } from "@/lib/request-lifecycle";

type CallMetric = {
  tool: string;
  durationMs: number;
  failed: boolean;
  timestamp: Date;
};
type Runtime = {
  enabled?: string;
  key?: string;
  host?: string;
  release?: string;
  waitUntil?: (task: Promise<void>) => void;
};
type Backend = {
  consent: typeof activeMcpConsent;
  withConsent: typeof withMcpConsent;
  send: typeof sendMcpMetric;
};

export async function sendMcpMetric(id: string, metric: CallMetric, runtime: Runtime) {
  if (runtime.enabled !== "1" || !runtime.key || !runtime.host) return;
  // Manual SDK capture deliberately never receives arguments, results, request
  // headers, OAuth identifiers or errors. No prepareTool* calls alter MCP schemas.
  const client = new PostHogMCP(runtime.key, {
    host: runtime.host,
    captureModel: false,
    enableConversationId: false,
    enableExceptionAutocapture: false,
    disableGeoip: true,
    flushAt: 20,
    flushInterval: 0,
    fetchRetryCount: 0,
    requestTimeout: 1500,
    before_send: (event) => {
      // Reject exception fan-out and rebuild the entire envelope. SDK updates
      // cannot quietly introduce content, profiles or cross-session identifiers.
      if (event?.event !== "$mcp_tool_call") return null;
      return {
        event: "$mcp_tool_call",
        distinctId: mcpAnalyticsId(id),
        timestamp: metric.timestamp,
        properties: {
          $mcp_source: "posthog_mcp_analytics",
          $mcp_server_name: "Tidy canvas",
          $mcp_method: "tools/call",
          $mcp_tool_name: metric.tool,
          $mcp_resource_name: metric.tool,
          $mcp_duration_ms: metric.durationMs,
          $mcp_is_error: metric.failed,
          ...(metric.failed ? { $mcp_error_type: "tool_error" } : {}),
          $process_person_profile: false,
          $geoip_disable: true,
          ...(runtime.release && /^[a-zA-Z0-9._-]{1,100}$/.test(runtime.release)
            ? { $app_version: runtime.release }
            : {}),
        },
      };
    },
  });
  client.on("error", () => console.warn(JSON.stringify({ event: "mcp_analytics_unavailable" })));
  try {
    client.captureToolCall({
      distinctId: mcpAnalyticsId(id),
      toolName: metric.tool,
      durationMs: metric.durationMs,
      isError: metric.failed,
      timestamp: metric.timestamp,
    });
  } finally {
    await client.shutdown(2000);
  }
}

function analyticsRuntime(): Runtime {
  let runtime: Runtime = {};
  try {
    const { env, ctx } = getCloudflareContext();
    runtime = {
      enabled: (env as CloudflareEnv & { POSTHOG_MCP_ANALYTICS_ENABLED?: string })
        .POSTHOG_MCP_ANALYTICS_ENABLED,
      waitUntil: (task) => ctx.waitUntil(task),
    };
  } catch {
    /* Local Next.js runtime. */
  }
  return {
    ...runtime,
    enabled: runtime.enabled ?? process.env.POSTHOG_MCP_ANALYTICS_ENABLED,
    key: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    release: process.env.NEXT_PUBLIC_APP_VERSION,
  };
}

export function instrumentMcpAnalytics(
  server: McpServer,
  userId: string,
  runtime = analyticsRuntime(),
  backend: Backend = {
    consent: activeMcpConsent,
    withConsent: withMcpConsent,
    send: sendMcpMetric,
  },
) {
  if (
    runtime.enabled !== "1" ||
    !runtime.key ||
    !runtime.host ||
    (process.env.NODE_ENV === "test" && backend.send === sendMcpMetric)
  )
    return server;
  type Handler = (...args: unknown[]) => Promise<unknown>;
  type Register = (name: string, config: unknown, callback: Handler) => unknown;
  const register = server.registerTool.bind(server) as Register;
  server.registerTool = ((tool: string, config: unknown, callback: Handler) =>
    register(tool, config, async (...args) => {
      // Registration supplies the name, never arbitrary client input.
      const consent = await backend.consent(userId).catch(() => undefined);
      const started = performance.now();
      const timestamp = new Date();
      let failed = true;
      try {
        const result = await callback(...args);
        failed = Boolean(
          result && typeof result === "object" && "isError" in result && result.isError,
        );
        return result;
      } finally {
        if (consent) {
          const metric = {
            tool,
            timestamp,
            failed,
            durationMs: Math.max(0, Math.round(performance.now() - started)),
          };
          const task = Promise.resolve()
            .then(() =>
              // A disconnected MCP client must not release the database consent
              // lock while a bounded outbound send is still running in waitUntil.
              runWithRequestSignal(new AbortController().signal, () =>
                backend.withConsent(userId, consent, () => backend.send(consent, metric, runtime)),
              ),
            )
            .catch(() => {
              /* Optional collection must never fail the tool. */
            });
          if (runtime.waitUntil) runtime.waitUntil(task);
          else await task;
        }
      }
    })) as McpServer["registerTool"];
  return server;
}
