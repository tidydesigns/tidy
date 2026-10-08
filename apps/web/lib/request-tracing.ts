import { PostHog } from "posthog-node/edge";
import type { Span, SpanRecord } from "posthog-node";
import { normalizedRoute } from "./route-normalization";
import {
  safeErrorCode,
  traceStorage,
  type OperationSpan,
  type RequestTrace,
  type TraceOperation,
} from "./trace-context";

export type TracingRuntime = {
  key?: string;
  host?: string;
  release?: string;
  deploymentId?: string;
  enabled?: string;
  environment?: string;
  waitUntil?: (task: Promise<unknown>) => void;
};

function markError(span: Span | undefined, error: unknown) {
  span?.setStatus("error", "operation_failed");
  const code = safeErrorCode(error);
  if (code) span?.setAttribute("error.code", code);
}

export function createRequestTrace(request: Request, runtime: TracingRuntime = {}) {
  const started = Date.now();
  const route = normalizedRoute(request.url);
  const attributes = {
    "http.request.method": request.method,
    "http.route": route,
    cf_ray: request.headers.get("cf-ray") ?? "",
    deployment_id: runtime.deploymentId ?? "",
    "app.version": runtime.release ?? "",
  };
  const configured =
    runtime.key &&
    runtime.host &&
    runtime.enabled !== "0" &&
    !new URL(request.url).pathname.startsWith("/_next/");
  const makeClient = () =>
    new PostHog(runtime.key!, {
      host: runtime.host,
      flushAt: 1,
      flushInterval: 0,
      fetchRetryCount: 0,
      requestTimeout: 2000,
      disableGeoip: true,
      enableExceptionAutocapture: false,
      traces: {
        serviceName: "tidy-app",
        serviceVersion: runtime.release,
        environment: runtime.environment ?? "production",
        flushIntervalMs: 0,
        maxExportBatchSize: 256,
        maxQueueSize: 512,
        // Only explicitly constructed attributes are recorded. As a final guard,
        // discard exception events and status messages from the SDK surface.
        beforeSpanSend(record: SpanRecord) {
          record.events = [];
          if (record.status) delete record.status.message;
          return record;
        },
      },
    });
  const deliver = (client: PostHog) => {
    const task = client.shutdown(2500).catch(() => {
      console.warn(JSON.stringify({ event: "trace_export_failed", route, ray: attributes.cf_ray }));
    });
    try {
      runtime.waitUntil?.(task);
    } catch {
      /* The caller may already have canceled the invocation. */
    }
    // Always contain export failures, including in tests or plain Node preview.
    return task;
  };
  let client: PostHog | undefined;
  try {
    if (configured) client = makeClient();
  } catch {
    console.warn(JSON.stringify({ event: "trace_initialization_failed", route }));
  }
  client?.on("error", () =>
    console.warn(JSON.stringify({ event: "trace_export_failed", route, ray: attributes.cf_ray })),
  );
  const name = `${request.method} ${route}`;
  const root = client?.startSpan(name, { kind: "server", attributes, startTime: started });
  let spanCount = 0;
  let dropped = 0;
  const trace: RequestTrace = {
    root,
    active: new Set(),
    closed: false,
    start(name: TraceOperation, parent?: OperationSpan): OperationSpan {
      // Bound memory even if a request loops or fans out indefinitely.
      if (spanCount++ >= 256) {
        dropped++;
        return { name, parent, started: Date.now(), run: (work) => work(), end: () => {} };
      }
      const span = client?.startSpan(name, { parent: parent?.span ?? root, startTime: Date.now() });
      let ended = false;
      const operation: OperationSpan = {
        name,
        span,
        parent,
        started: Date.now(),
        run: (work) => traceStorage.run({ trace, operation }, work),
        end(error) {
          if (ended) return;
          ended = true;
          if (error !== undefined) markError(span, error);
          span?.end();
          trace.active.delete(operation);
        },
      };
      trace.active.add(operation);
      return operation;
    },
  };
  let snapshotSent = false;
  return {
    run<T>(work: () => T): T {
      return traceStorage.run({ trace }, work);
    },
    operations: () => [...new Set([...trace.active].map((item) => item.name))],
    traceId: () => root?.traceparent()?.split("-")[1],
    snapshot() {
      if (!client || trace.closed || snapshotSent) return;
      snapshotSent = true;
      // A hanging operation never ends, so ordinary span flushing cannot expose
      // it. Export a separate, explicitly marked snapshot trace with backdated
      // spans; preserve the actual spans for the eventual request outcome.
      let snapshotClient: PostHog;
      try {
        snapshotClient = makeClient();
      } catch {
        console.warn(JSON.stringify({ event: "trace_initialization_failed", route }));
        return;
      }
      snapshotClient.on("error", () =>
        console.warn(
          JSON.stringify({ event: "trace_export_failed", route, ray: attributes.cf_ray }),
        ),
      );
      const end = Date.now();
      const snapshotRoot = snapshotClient.startSpan(name, {
        kind: "server",
        startTime: started,
        attributes: {
          ...attributes,
          "app.snapshot": true,
          "app.unfinished": true,
          "app.request_trace_id": root?.traceparent()?.split("-")[1] ?? "",
        },
      });
      snapshotRoot.setStatus("error");
      const copies = new Map<OperationSpan, Span>();
      for (const operation of trace.active) {
        const copy = snapshotClient.startSpan(operation.name, {
          parent: operation.parent ? (copies.get(operation.parent) ?? snapshotRoot) : snapshotRoot,
          startTime: operation.started,
          attributes: { "app.snapshot": true, "app.unfinished": true },
        });
        copy.setStatus("error");
        copy.end(end);
        copies.set(operation, copy);
      }
      snapshotRoot.end(end);
      void deliver(snapshotClient);
    },
    finish(outcome: string, status?: number, error?: unknown) {
      if (trace.closed) return;
      trace.closed = true;
      for (const operation of trace.active) {
        operation.span?.setAttribute("app.unfinished", true);
        operation.span?.setAttribute("app.request_outcome", outcome);
        operation.end(error ?? new Error("request_ended"));
      }
      root?.setAttributes({ "app.request_outcome": outcome, "app.dropped_spans": dropped });
      if (status !== undefined) root?.setAttribute("http.response.status_code", status);
      if (
        error !== undefined ||
        (status && status >= 500) ||
        outcome.includes("failed") ||
        outcome.includes("cancel") ||
        outcome.includes("abort")
      )
        markError(root, error);
      root?.end();
      if (client) void deliver(client);
    },
  };
}
