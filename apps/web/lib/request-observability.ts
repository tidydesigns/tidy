import { requestPhases } from "./request-lifecycle";
import { normalizedRoute } from "./route-normalization";
import { createRequestTrace, type TracingRuntime } from "./request-tracing";
import { startOperation, traceOperation } from "./trace-context";
export { normalizedRoute } from "./route-normalization";

type ReportFailure = (
  error: unknown,
  details: {
    source: "worker";
    event: string;
    route: string;
    method: string;
    phase: string;
    elapsedMs: number;
    status?: number;
    bytes: number;
    kind: string;
    prefetch: boolean;
  },
) => Promise<void>;

export async function observeRequest(
  request: Request,
  handle: () => Promise<Response>,
  report?: ReportFailure,
  runtime?: TracingRuntime,
): Promise<Response> {
  const trace = await createRequestTrace(request, runtime);
  return trace.run(() => observeTracedRequest(request, handle, trace, report));
}

async function observeTracedRequest(
  request: Request,
  handle: () => Promise<Response>,
  trace: Awaited<ReturnType<typeof createRequestTrace>>,
  report?: ReportFailure,
): Promise<Response> {
  const started = performance.now();
  const kind =
    request.headers.get("rsc") === "1"
      ? "rsc"
      : request.headers.get("sec-fetch-dest") === "document"
        ? "document"
        : "other";
  const details = {
    method: request.method,
    route: normalizedRoute(request.url),
    ray: request.headers.get("cf-ray"),
    kind,
    prefetch: request.headers.has("next-router-prefetch"),
  };
  let phase = "handler";
  let status: number | undefined;
  let bytes = 0;
  let finished = false;
  let watchingBody = false;
  let bodyOperation: ReturnType<typeof startOperation> | undefined;
  const elapsed = () => Math.round(performance.now() - started);
  const reportFailure = (event: string, error: unknown = new Error(event)) => {
    void report?.(error, {
      source: "worker",
      event,
      ...details,
      phase,
      status,
      bytes,
      elapsedMs: elapsed(),
    }).catch(() => {});
  };
  let pending: ReturnType<typeof setTimeout> | undefined;
  let reportedStall = false;
  const watchForStall = () => {
    if (finished || reportedStall) return;
    pending = setTimeout(() => {
      reportedStall = true;
      console.warn(
        JSON.stringify({
          event: "request_stalled",
          ...details,
          phase,
          operations: trace.operations(),
          phases: requestPhases(),
          trace_id: trace.traceId(),
          status,
          bytes,
          elapsedMs: elapsed(),
        }),
      );
      reportFailure("request_stalled");
      trace.snapshot();
    }, 10_000);
  };
  watchForStall();
  const finish = (event: string, error?: unknown) => {
    if (finished) return;
    finished = true;
    clearTimeout(pending);
    request.signal.removeEventListener("abort", aborted);
    if (event === "response_body_completed" || event === "response_body_failed")
      bodyOperation?.end(error);
    trace.finish(event, status, error);
    const record = JSON.stringify({
      event,
      ...details,
      phase,
      status,
      bytes,
      elapsedMs: elapsed(),
    });
    if (event.endsWith("failed")) console.error(record);
    else if (trace.sampled) console.info(record);
  };
  const aborted = () => finish("request_aborted");
  request.signal.addEventListener("abort", aborted, { once: true });
  if (request.signal.aborted) aborted();
  if (kind !== "other" && trace.sampled)
    console.info(JSON.stringify({ event: "request_started", ...details }));
  try {
    const response = await traceOperation("worker.routing", handle);
    status = response.status;
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim();
    const mcpStream =
      request.method === "POST" &&
      details.route === "/api/mcp" &&
      contentType === "text/event-stream";
    // OpenNext pages and legacy MCP POSTs can return headers before their work
    // completes. Keep the request trace alive through those finite streams, so
    // MCP execution/database spans aren't marked unfinished at SSE headers.
    if (
      status === 101 ||
      response.body === null ||
      !(
        (request.method === "GET" &&
          (contentType === "text/html" || contentType === "text/x-component")) ||
        mcpStream
      )
    ) {
      const elapsedMs = elapsed();
      if (status >= 500 || elapsedMs >= 1000) {
        console.warn(JSON.stringify({ event: "request_completed", ...details, status, elapsedMs }));
      }
      trace.finish("request_completed", status);
      return response;
    }
    watchingBody = true;
    if (mcpStream) clearTimeout(pending);
    phase = "body";
    bodyOperation = startOperation("response.body");
    if (trace.sampled)
      console.info(
        JSON.stringify({ event: "response_headers", ...details, status, elapsedMs: elapsed() }),
      );
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          return trace.run(async () => {
            if (mcpStream) watchForStall();
            try {
              const next = await reader.read();
              if (next.done) {
                finish("response_body_completed");
                controller.close();
                reader.releaseLock();
              } else {
                bytes += next.value.byteLength;
                controller.enqueue(next.value);
              }
            } catch (error) {
              if (!finished) reportFailure("response_body_failed", error);
              finish("response_body_failed", error);
              controller.error(error);
              reader.releaseLock();
            } finally {
              if (mcpStream) clearTimeout(pending);
            }
          });
        },
        async cancel(reason) {
          return trace.run(async () => {
            finish("response_body_canceled");
            try {
              await reader.cancel(reason);
            } finally {
              reader.releaseLock();
            }
          });
        },
      },
      { highWaterMark: 0 },
    );
    // Pass chunks through on demand: no cloning, teeing or buffering the page.
    return new Response(body, response);
  } catch (error) {
    reportFailure("request_failed", error);
    watchingBody = false;
    finish("request_failed", error);
    throw error;
  } finally {
    if (!watchingBody) {
      clearTimeout(pending);
      request.signal.removeEventListener("abort", aborted);
    }
  }
}
