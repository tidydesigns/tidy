import { normalizedRoute } from "./request-observability";
import {
  requestPhases,
  runWithRequestSignal,
  startRequestPhase,
  traceRequestPhase,
  waitForSignal,
} from "./request-lifecycle";

export function requestDeadline(request: Request) {
  const path = new URL(request.url).pathname;
  // These small reads and ephemeral tickets should finish before the editor's
  // ten-second client deadline. Never classify an edit mutation as a read.
  if (
    (request.method === "GET" &&
      (path === "/api/auth/get-session" ||
        /^\/api\/files\/[^/]+\/(changes|snapshot)$/.test(path))) ||
    (request.method === "POST" && /^\/api\/files\/[^/]+\/presence-ticket$/.test(path))
  )
    return 8000;
  return 20_000;
}

function unavailable(request: Request) {
  const headers = {
    "Cache-Control": "no-store",
    "Retry-After": "5",
    "X-Content-Type-Options": "nosniff",
  };
  const browser =
    request.method === "GET" &&
    request.headers.get("accept")?.includes("text/html") &&
    request.headers.get("rsc") !== "1";
  if (!browser)
    return Response.json({ error: "temporarily_unavailable" }, { status: 503, headers });
  return new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connection interrupted · Tidy</title><body><p>Tidy took too long to respond.</p><a href="">Try again</a></body></html>',
    {
      status: 503,
      headers: {
        ...headers,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

/** Bound routing and finite page rendering; do not buffer or truncate MCP SSE. */
export async function handleRequest<T extends Request>(
  request: T,
  handle: (request: T) => Promise<Response>,
  timeoutMs = requestDeadline(request),
  report?: (error: unknown, details: import("./posthog-server").ErrorDetails) => Promise<void>,
) {
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const started = performance.now();
  const bounded = new Request(request, { signal }) as T;
  return runWithRequestSignal(signal, async () => {
    const timer = setTimeout(() => {
      console.warn(
        JSON.stringify({
          event: "request_timed_out",
          route: normalizedRoute(request.url),
          method: request.method,
          ray: request.headers.get("cf-ray"),
          phases: requestPhases(),
          elapsedMs: Math.round(performance.now() - started),
        }),
      );
      const error = new DOMException("Request timed out", "TimeoutError");
      void report?.(error, {
        source: "worker",
        event: "request_timed_out",
        route: normalizedRoute(request.url),
        method: request.method,
        phase: requestPhases().join(",") || "routing",
        elapsedMs: Math.round(performance.now() - started),
      }).catch(() => {});
      controller.abort(error);
    }, timeoutMs);

    let streaming = false;
    try {
      signal.throwIfAborted();
      const response = await waitForSignal(
        traceRequestPhase("routing", () => handle(bounded)),
        signal,
      );
      const type = response.headers.get("content-type")?.split(";", 1)[0].trim();
      streaming =
        response.status !== 101 &&
        response.body !== null &&
        (type === "text/html" || type === "text/x-component");
      if (!streaming) return response;
      const finishBody = startRequestPhase("body");
      const reader = response.body!.getReader();
      let finished = false;
      const finish = () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          finishBody();
        }
      };
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(destination) {
            try {
              const next = await waitForSignal(reader.read(), signal);
              if (next.done) {
                finish();
                destination.close();
                reader.releaseLock();
              } else destination.enqueue(next.value);
            } catch (error) {
              finish();
              destination.error(error);
              // Also stop the source if its pending read ignored cancellation.
              try {
                await reader.cancel(error);
              } finally {
                reader.releaseLock();
              }
            }
          },
          async cancel(reason) {
            finish();
            controller.abort(new DOMException("Response canceled", "AbortError"));
            try {
              await reader.cancel(reason);
            } finally {
              reader.releaseLock();
            }
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, response);
    } catch (error) {
      if (!signal.aborted) throw error;
      return unavailable(request);
    } finally {
      if (!streaming) clearTimeout(timer);
    }
  });
}
