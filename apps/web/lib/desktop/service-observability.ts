import { z } from "zod";

export const serviceMetricSchema = z
  .object({
    day: z.iso.date(),
    operation: z.enum([
      "account",
      "manifest",
      "catalog",
      "file_list",
      "file_create",
      "file_read",
      "file_commit",
      "file_rename",
      "asset_read",
      "asset_write",
      "thumbnail",
      "creator_avatar",
    ]),
    outcome: z.enum([
      "success",
      "not_modified",
      "invalid_request",
      "unauthorized",
      "forbidden",
      "missing",
      "conflict",
      "too_large",
      "rate_limited",
      "unavailable",
      "server_error",
      "other",
    ]),
    latency: z.enum(["under_100ms", "under_1s", "under_5s", "under_20s", "over_20s"]),
  })
  .strict();
export type ServiceMetric = z.infer<typeof serviceMetricSchema>;

/** Classify only existing functional requests; never retain paths, queries or client headers. */
export function desktopServiceOperation(request: Request): ServiceMetric["operation"] | undefined {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (method === "GET" && path === "/api/desktop/account") return "account";
  if (method === "POST" && path === "/api/desktop/manifest") return "manifest";
  if (/^\/api\/desktop\/organizations\/[^/]+\/catalog$/.test(path) && method === "GET")
    return "catalog";
  if (/^\/api\/desktop\/organizations\/[^/]+\/files$/.test(path)) {
    if (method === "GET") return "file_list";
    if (method === "POST") return "file_create";
  }
  if (/^\/api\/desktop\/files\/[^/]+$/.test(path)) {
    if (method === "GET") return "file_read";
    if (method === "POST") return "file_commit";
  }
  if (/^\/api\/desktop\/files\/[^/]+\/name$/.test(path) && method === "POST") return "file_rename";
  if (/^\/api\/desktop\/files\/[^/]+\/assets$/.test(path)) {
    if (method === "GET") return "asset_read";
    if (method === "POST") return "asset_write";
  }
  if (/^\/api\/desktop\/files\/[^/]+\/thumbnail$/.test(path) && method === "GET")
    return "thumbnail";
  if (/^\/api\/desktop\/files\/[^/]+\/creator-avatar$/.test(path) && method === "GET")
    return "creator_avatar";
}

function outcome(status: number): ServiceMetric["outcome"] {
  if (status >= 200 && status < 300) return "success";
  if (status === 304) return "not_modified";
  if (status === 400) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "missing";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  if (status >= 500) return "server_error";
  return "other";
}

/** The sink receives four reviewed dimensions, never the Request, Response or exception. */
export async function observeDesktopService(
  request: Request,
  handle: () => Promise<Response>,
  report: (metric: ServiceMetric) => void,
): Promise<Response> {
  const operation = desktopServiceOperation(request);
  if (!operation) return handle();
  const day = new Date().toISOString().slice(0, 10);
  const started = performance.now();
  let status = 500;
  try {
    const response = await handle();
    status = response.status;
    return response;
  } finally {
    const elapsed = performance.now() - started;
    try {
      report({
        day,
        operation,
        outcome: outcome(status),
        latency:
          elapsed < 100
            ? "under_100ms"
            : elapsed < 1000
              ? "under_1s"
              : elapsed < 5000
                ? "under_5s"
                : elapsed < 20000
                  ? "under_20s"
                  : "over_20s",
      });
    } catch {
      // Operational reporting must never change service responses or throw raw errors into logs.
    }
  }
}
