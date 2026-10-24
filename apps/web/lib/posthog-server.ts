import { admitServerError } from "./security/server-telemetry-budget";
import { posthogServerErrorsEnabled } from "./posthog-policy";
import { PostHog } from "posthog-node";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { normalizedRoute } from "./route-normalization";
import { diagnosticMessage } from "./privacy/error-diagnostics";

export type ErrorDetails = {
  source: "worker" | "next" | "operation";
  event: string;
  route?: string;
  method?: string;
  phase?: string;
  operation?: string;
  status?: number;
  elapsedMs?: number;
  bytes?: number;
  kind?: string;
  prefetch?: boolean;
  digest?: string;
};

type ReportingRuntime = {
  serverErrorsEnabled?: string;
  key?: string;
  host?: string;
  release?: string;
  deploymentId?: string;
  waitUntil?: (task: Promise<unknown>) => void;
  admit?: (fingerprint: string) => Promise<boolean>;
};

const failureEvents = new Set([
  "server_request_failed",
  "request_failed",
  "request_stalled",
  "request_timed_out",
  "auth_request_timed_out",
  "response_body_failed",
  "operation_stalled",
  "operation_failed",
]);
const operations = new Set([
  "action.failed",
  "files.manage",
  "mcp.admission",
  "workspace.session",
  "workspace.organizations",
  "workspace.role",
  "files.session",
  "files.organizations",
  "files.role",
  "files.folders",
  "files.schema",
  "files.list",
  "asset.session",
  "asset.query",
  "settings.agents_availability",
  "settings.billing_availability",
]);
const phases = new Set([
  "handler",
  "body",
  "routing",
  "response_body",
  "initialize",
  "api",
  "endpoint",
  "render",
  "route",
  "action",
  "middleware",
  "proxy",
]);
function safeFailureEvent(event: string) {
  return failureEvents.has(event) ? event : "server_request_failed";
}
function safeRoute(route: string | undefined) {
  if (!route) return undefined;
  try {
    return normalizedRoute(new URL(route, "https://tidy.invalid").href).slice(0, 300);
  } catch {
    return undefined;
  }
}
function safeDetails(details: ErrorDetails) {
  const result: Record<string, string | number | boolean> = {
    source: ["worker", "next", "operation"].includes(details.source) ? details.source : "next",
    event: safeFailureEvent(details.event),
  };
  const route = safeRoute(details.route);
  if (route) result.route = route;
  if (details.operation && operations.has(details.operation)) result.operation = details.operation;
  if (
    details.method &&
    ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(details.method)
  )
    result.method = details.method;
  if (details.phase) {
    const selected = details.phase
      .split(",")
      .filter((phase) => phases.has(phase))
      .slice(0, 8);
    if (selected.length) result.phase = selected.join(",");
  }
  for (const key of ["status", "elapsedMs", "bytes"] as const) {
    const value = details[key];
    if (typeof value === "number" && Number.isFinite(value))
      result[key] = Math.max(0, Math.min(value, 1e9));
  }
  if (details.kind && ["rsc", "document", "other"].includes(details.kind))
    result.kind = details.kind;
  if (typeof details.prefetch === "boolean") result.prefetch = details.prefetch;
  // No spreading caller data: digest, ray, URLs, headers, identities and custom fields are excluded.
  return result;
}
function safeBuildLabel(value: string | undefined) {
  return value && /^[a-zA-Z0-9._-]{1,100}$/.test(value) ? value : undefined;
}

export function serverErrorCategory(value: unknown) {
  // Application wrappers retain their safe public message while causes keep a
  // bounded diagnostic category. Never forward cause messages or stack frames.
  for (let depth = 0; value instanceof Error && depth < 5; depth++) {
    const category = directServerErrorCategory(value);
    if (category !== "unknown") return category;
    value = value.cause;
  }
  return "unknown";
}

function directServerErrorCategory(value: Error) {
  // Fixed categories retain diagnostic value without sending SQL, URLs, cookies
  // or provider messages. Do not forward arbitrary Error.code values.
  const code = "code" in value ? value.code : undefined;
  const codes: Record<string, string> = {
    ECONNRESET: "connection_reset",
    ECONNREFUSED: "connection_refused",
    ETIMEDOUT: "connection_timeout",
    ENOTFOUND: "dns_failure",
    "08000": "database_connection",
    "08003": "database_connection",
    "08006": "database_connection",
    "53300": "database_connection_capacity",
    "57014": "database_query_canceled",
    "23505": "database_unique_conflict",
    "23503": "database_reference_conflict",
    "40P01": "database_deadlock",
    "40001": "database_serialization_conflict",
  };
  if (typeof code === "string" && Object.hasOwn(codes, code)) return codes[code];
  if (value.name === "AbortError") return "canceled";
  if (value.name === "TimeoutError" || /timeout|timed out|Query read timeout/i.test(value.message))
    return "timeout";
  if (
    value.message
      .toLowerCase()
      .split(/[\r\n\u2028\u2029]/)
      .some((line) => {
        const start = line.indexOf("i/o");
        return start !== -1 && line.includes("different request", start + 3);
      })
  )
    return "cross_request_io";
  if (/binding is (?:missing|required)/i.test(value.message)) return "missing_runtime_binding";
  return "unknown";
}

export function safeServerError(value: unknown, event: string) {
  // Messages can contain SQL parameters or user data. Preserve code locations
  // while reporting a bounded diagnostic message, without causes/properties.
  const category = serverErrorCategory(value);
  const label = safeFailureEvent(event);
  const technical = value instanceof Error ? diagnosticMessage(value.message, value.name) : "";
  const message =
    category !== "unknown"
      ? `${label}: ${category}`
      : technical &&
          technical !== (value instanceof Error ? value.name : "Error") &&
          technical !== "Error"
        ? `${label}: ${technical}`
        : label;
  const error = new Error(message);
  error.name =
    value instanceof Error &&
    ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError"].includes(value.name)
      ? value.name
      : "Error";
  // A non-Error (or an Error without a stack) must not fall back to the new
  // wrapper's own stack, which includes this machine's absolute paths.
  error.stack = `${error.name}: ${message}`;
  if (value instanceof Error && value.stack) {
    const frames = value.stack
      .split("\n")
      .slice(0, 40)
      .filter((line) => /^\s+at /.test(line))
      .flatMap((line) => {
        // Only a code file basename and numeric location. Drop function names,
        // machine paths, hosts, query/fragment values and non-code frames.
        const clean = line.replace(/[?#][^\s)]*/g, "");
        const match = clean.match(
          /(?:^|[\s/\\(])([a-zA-Z0-9_.-]+\.(?:[cm]?js|tsx?)):(\d{1,8}):(\d{1,8})\)?$/,
        );
        return match ? [`    at ${match[1]}:${match[2]}:${match[3]}`] : [];
      });
    error.stack = `${error.name}: ${message}\n${frames.join("\n")}`;
  }
  return error;
}

export function createErrorReporter(runtime?: ReportingRuntime) {
  // This path never reads request headers, browser storage or optional consent.
  // The independent switch keeps the production pause until explicitly enabled.
  if (process.env.NODE_ENV === "test" && !runtime?.key) return async () => {};
  if (!runtime) {
    try {
      const { ctx, env } = getCloudflareContext();
      runtime = {
        serverErrorsEnabled: (env as CloudflareEnv & { POSTHOG_SERVER_ERRORS_ENABLED?: string })
          .POSTHOG_SERVER_ERRORS_ENABLED,
        deploymentId: env.CF_VERSION_METADATA?.id,
        admit: (fingerprint) => admitServerError(env, fingerprint),
        waitUntil: (task: Promise<unknown>) => ctx.waitUntil(task),
      };
    } catch {
      runtime = {};
    }
  }
  if (!posthogServerErrorsEnabled(runtime?.serverErrorsEnabled)) return async () => {};
  const key = runtime.key ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = runtime.host ?? process.env.NEXT_PUBLIC_POSTHOG_HOST;
  const release = safeBuildLabel(runtime.release ?? process.env.NEXT_PUBLIC_APP_VERSION);
  const deploymentId = safeBuildLabel(runtime.deploymentId);
  const waitUntil = runtime.waitUntil;
  const admit = runtime.admit;
  // Server-generated correlation within this reporter only; never a person/session ID.
  const reportId = crypto.randomUUID();

  return (value: unknown, details: ErrorDetails): Promise<void> => {
    const diagnostic = safeDetails(details);
    if (
      !key ||
      !host ||
      diagnostic.route === "/api/t" ||
      String(diagnostic.route).startsWith("/api/t/")
    )
      return Promise.resolve();
    const safeError = safeServerError(value, String(diagnostic.event));
    // Preserve locations for SDK chunk-ID lookup without allowing Error.cause or
    // arbitrary properties to change which exception's frames are reported.
    const sdkError = new Error(safeError.message);
    sdkError.name = safeError.name;
    sdkError.stack =
      value instanceof Error && value.stack
        ? `${safeError.name}: ${safeError.message}\n${value.stack
            .split("\n")
            .filter((line) => /^\s+at /.test(line))
            .slice(0, 40)
            .join("\n")}`
        : safeError.stack;
    const properties = {
      ...diagnostic,
      error_category: serverErrorCategory(value),
      server_report_id: reportId,
      telemetry_scope: "server_reliability",
      deployment_id: deploymentId,
      $app_version: release,
      $process_person_profile: false,
      $geoip_disable: true,
      ...(String(diagnostic.event).endsWith("stalled") ||
      String(diagnostic.event).endsWith("timed_out")
        ? {
            $exception_fingerprint: `tidy:${diagnostic.event}:${diagnostic.operation ?? diagnostic.route ?? "server"}:${diagnostic.phase ?? "handler"}`,
          }
        : {}),
    };
    const task = (async () => {
      const fingerprint = [
        diagnostic.event,
        diagnostic.route,
        diagnostic.operation,
        diagnostic.phase,
        serverErrorCategory(value),
      ].join(":");
      if (admit && !(await admit(fingerprint).catch(() => false))) return;
      const client = new PostHog(key, {
        host,
        flushAt: 1,
        flushInterval: 0,
        fetchRetryCount: 0,
        requestTimeout: 2000,
        disableGeoip: true,
        enableExceptionAutocapture: false,
        before_send: (event) => {
          if (!event || event.event !== "$exception") return null;
          // Rebuild the payload after SDK enrichment as well. Context tags,
          // identity/session metadata and source snippets cannot bypass the boundary.
          const frames = event.properties?.$exception_list?.[0]?.stacktrace?.frames;
          event.properties = {
            ...properties,
            $exception_list: [
              {
                type: safeError.name,
                value: safeError.message,
                mechanism: { type: "generic", handled: true, synthetic: false, exception_id: 0 },
                stacktrace: {
                  type: "raw",
                  frames: Array.isArray(frames)
                    ? frames
                        .slice(0, 40)
                        .filter(
                          (frame) =>
                            typeof frame.filename === "string" &&
                            /(?:^|[\/\\])([a-zA-Z0-9_.-]+\.(?:[cm]?js|tsx?))$/.test(
                              frame.filename,
                            ) &&
                            Number.isSafeInteger(frame.lineno) &&
                            Number.isSafeInteger(frame.colno),
                        )
                        .map((frame) => ({
                          filename: frame.filename!.split(/[\/\\]/).at(-1),
                          // Keep the required wire field without exposing the SDK's name.
                          function: "<redacted>",
                          lineno: frame.lineno,
                          colno: frame.colno,
                          platform: "node:javascript",
                          in_app: true,
                          ...(typeof frame.chunk_id === "string" &&
                          /^[\da-f-]{36}$/i.test(frame.chunk_id)
                            ? { chunk_id: frame.chunk_id }
                            : {}),
                        }))
                    : [],
                },
              },
            ],
            $exception_level: "error",
            ...(typeof event.properties?.$release_id === "string" &&
            /^[\w.-]{1,100}$/.test(event.properties.$release_id)
              ? { $release_id: event.properties.$release_id }
              : {}),
            $lib: "posthog-node",
          };
          event.distinctId = "tidy-server";
          return event;
        },
      });
      client.on("error", () => {
        console.warn(
          JSON.stringify({ event: "error_reporting_failed", source: diagnostic.source }),
        );
      });
      try {
        // Let the SDK resolve injected chunk IDs using the original code path.
        // before_send rebuilds all outbound fields; raw messages/causes never leave.
        await client.captureExceptionImmediate(sdkError, "tidy-server", properties);
      } finally {
        await client.shutdown(2500);
      }
    })().catch(() => {
      console.warn(JSON.stringify({ event: "error_reporting_failed", source: diagnostic.source }));
    });
    if (waitUntil) {
      waitUntil(task);
      return Promise.resolve();
    }
    return task;
  };
}
