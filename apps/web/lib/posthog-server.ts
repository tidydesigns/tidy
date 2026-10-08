import { PostHog } from "posthog-node";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { safeErrorCode, traceDetails } from "./trace-context";

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

type HeaderReader = Pick<Headers, "get">;
type ReportingRuntime = {
  key?: string;
  host?: string;
  release?: string;
  deploymentId?: string;
  waitUntil?: (task: Promise<unknown>) => void;
};

// Extract only analytics identity from this project's cookie, never auth data.
export function analyticsIdentity(headers: HeaderReader, key: string) {
  const prefix = `ph_${key}_posthog=`;
  const cookie = headers
    .get("cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  if (!cookie || cookie.length > 16_384) return undefined;
  try {
    const value = JSON.parse(decodeURIComponent(cookie.slice(prefix.length)));
    return typeof value.distinct_id === "string" && value.distinct_id.length <= 200
      ? value.distinct_id
      : undefined;
  } catch {
    return undefined;
  }
}

export function serverErrorCategory(value: unknown) {
  // Fixed categories retain diagnostic value without sending SQL, URLs, cookies
  // or provider messages. Do not forward arbitrary Error.code values.
  if (!(value instanceof Error)) return "unknown";
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
  if (/I\/O.*different request/i.test(value.message)) return "cross_request_io";
  if (/binding is missing/i.test(value.message)) return "missing_runtime_binding";
  return "unknown";
}

export function safeServerError(value: unknown, event: string) {
  // Messages can contain SQL parameters or user data. Preserve code locations
  // while reporting a bounded diagnostic message, without causes/properties.
  const category = serverErrorCategory(value);
  const message = category === "unknown" ? event : `${event}: ${category}`;
  const error = new Error(message);
  error.name =
    value instanceof Error &&
    ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError"].includes(value.name)
      ? value.name
      : "Error";
  if (value instanceof Error && value.stack) {
    const frames = value.stack
      .split("\n")
      .filter((line) => /^\s+at /.test(line))
      .map((line) => line.replace(/(https?:\/\/[^\s?#)]+)[?#][^\s)]*/g, "$1"));
    error.stack = `${error.name}: ${message}\n${frames.join("\n")}`;
  }
  return error;
}

export function createErrorReporter(headers: HeaderReader, runtime?: ReportingRuntime) {
  // Tests exercise delivery only with explicit test credentials/transport.
  if (process.env.NODE_ENV === "test" && !runtime?.key) return async () => {};
  if (!runtime) {
    try {
      const { ctx, env } = getCloudflareContext();
      runtime = {
        deploymentId: env.CF_VERSION_METADATA?.id,
        waitUntil: (task) => ctx.waitUntil(task),
      };
    } catch {
      runtime = {};
    } // Plain Next.js development/test runtime.
  }
  const key = runtime.key ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = runtime.host ?? process.env.NEXT_PUBLIC_POSTHOG_HOST;
  const release = runtime.release ?? process.env.NEXT_PUBLIC_APP_VERSION;
  const waitUntil = runtime.waitUntil;
  const deploymentId = runtime.deploymentId;
  const distinctId = key ? analyticsIdentity(headers, key) : undefined;
  const ray = headers.get("cf-ray");

  return (value: unknown, details: ErrorDetails): Promise<void> => {
    if (!key || !host) return Promise.resolve();
    const task = (async () => {
      // Never share pending SDK I/O between Worker invocations.
      const client = new PostHog(key, {
        host,
        flushAt: 1,
        flushInterval: 0,
        fetchRetryCount: 0,
        requestTimeout: 2000,
        disableGeoip: true,
        // Use Next/Worker hooks instead of process-global Node listeners.
        enableExceptionAutocapture: false,
        before_send: (event) => {
          // The Node SDK can read source snippets from disk. Source maps supply
          // code context separately; raw telemetry only needs frame locations.
          for (const exception of event?.properties?.$exception_list ?? []) {
            for (const frame of exception.stacktrace?.frames ?? []) {
              delete frame.pre_context;
              delete frame.context_line;
              delete frame.post_context;
              delete frame.vars;
            }
          }
          return event;
        },
      });
      client.on("error", () => {
        console.warn(
          JSON.stringify({ event: "error_reporting_failed", source: details.source, ray }),
        );
      });
      try {
        await client.captureExceptionImmediate(
          safeServerError(value, details.event),
          distinctId ?? "tidy-server",
          {
            ...details,
            error_category: serverErrorCategory(value),
            cf_ray: ray,
            deployment_id: deploymentId,
            $app_version: release,
            $process_person_profile: false,
            ...traceDetails(),
            error_code: safeErrorCode(value),
            ...(details.event.endsWith("stalled") || details.event.endsWith("timed_out")
              ? {
                  $exception_fingerprint: `tidy:${details.event}:${details.operation ?? details.route}:${details.phase ?? "handler"}`,
                }
              : {}),
          },
        );
      } finally {
        await client.shutdown(2500);
      }
    })().catch(() => {
      console.warn(
        JSON.stringify({ event: "error_reporting_failed", source: details.source, ray }),
      );
    });
    if (waitUntil) {
      waitUntil(task);
      return Promise.resolve();
    }
    return task;
  };
}
