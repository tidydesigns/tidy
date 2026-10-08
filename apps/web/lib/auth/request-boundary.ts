import {
  requestPhases,
  runWithRequestSignal,
  traceAuthOperation,
  waitForSignal,
} from "./request-lifecycle";
import { normalizedRoute } from "../request-observability";

export function isAuthRequest(path: string) {
  return (
    path === "/api/auth" ||
    path.startsWith("/api/auth/") ||
    ["/login", "/sign-up", "/forgot-password", "/reset-password", "/mcp/consent"].includes(path) ||
    path.startsWith("/.well-known/oauth-") ||
    path.startsWith("/.well-known/openid-configuration")
  );
}

export function authUnavailable(request: Request) {
  const browser =
    request.method === "GET" &&
    request.headers.get("rsc") !== "1" &&
    (request.headers.get("sec-fetch-mode") === "navigate" ||
      request.headers.get("accept")?.includes("text/html"));
  const headers = {
    "Cache-Control": "no-store",
    "Retry-After": "5",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  };
  if (!browser)
    return Response.json(
      {
        error: "temporarily_unavailable",
        error_description:
          "Authentication is temporarily unavailable. Start authorization again if your login command has timed out.",
      },
      { status: 503, headers },
    );
  // No request parameters, credentials, or unvalidated redirect targets appear
  // in this page. An empty link repeats this GET; mutations are never retried.
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connection interrupted · Tidy</title><style>body{font:16px system-ui;margin:15vh auto;padding:24px;max-width:420px;color:#252525;line-height:1.6}h1{font-size:24px}a{color:inherit}p{color:#555}</style><h1>Connection interrupted</h1><p>Tidy took too long to respond. Try again in a moment. If your agent's login command has timed out, start it again.</p><a href="">Try again</a></html>`,
    { status: 503, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function handleAuthRequest<Cf extends CfProperties>(
  request: Request<unknown, Cf>,
  handle: (request: Request<unknown, Cf>) => Promise<Response>,
  timeoutMs = 20_000,
  report?: (error: unknown, details: import("../posthog-server").ErrorDetails) => Promise<void>,
) {
  const started = performance.now();
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(new DOMException("Authentication request timed out", "TimeoutError")),
    timeoutMs,
  );
  // Cloning the incoming request preserves its Cloudflare metadata.
  const boundedRequest = new Request(request, { signal }) as Request<unknown, Cf>;
  return runWithRequestSignal(signal, async () => {
    try {
      const work = traceAuthOperation("routing", async () => {
        const response = await handle(boundedRequest);
        const path = new URL(request.url).pathname;
        // These are finite auth responses, never MCP SSE or WebSocket streams.
        // Buffering makes a stalled HTML/JSON body replaceable by a useful 503.
        const body = response.body
          ? await traceAuthOperation("response_body", () => readAuthBody(response, signal))
          : null;
        const headers = new Headers(response.headers);
        if (!path.startsWith("/.well-known/")) headers.set("Cache-Control", "no-store");
        headers.set("Referrer-Policy", "no-referrer");
        headers.set("X-Frame-Options", "DENY");
        headers.set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'");
        headers.set("X-Content-Type-Options", "nosniff");
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      });
      return await waitForSignal(work, signal);
    } catch (error) {
      if (!signal.aborted && !(error instanceof DOMException && error.name === "TimeoutError"))
        throw error;
      if (!signal.aborted) controller.abort(error);
      void report?.(error, {
        source: "worker",
        event: "auth_request_timed_out",
        route: normalizedRoute(request.url),
        method: request.method,
        phase: requestPhases().join(",") || "routing",
        elapsedMs: Math.round(performance.now() - started),
      }).catch(() => {});
      console.warn(
        JSON.stringify({
          event: "auth_request_timed_out",
          route: normalizedRoute(request.url),
          phase: requestPhases(),
          ray: request.headers.get("cf-ray"),
          method: request.method,
          elapsedMs: Math.round(performance.now() - started),
          elapsedLimitMs: timeoutMs,
        }),
      );
      return authUnavailable(request);
    } finally {
      clearTimeout(timer);
    }
  });
}

async function readAuthBody(response: Response, signal: AbortSignal) {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await waitForSignal(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_048_576) {
        cancel();
        throw new Error("Authentication response exceeded the size limit.");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
