import { AsyncLocalStorage } from "node:async_hooks";
import type { Span } from "posthog-node";

export type TraceOperation =
  | "worker.routing"
  | "auth.initialize"
  | "auth.api"
  | "auth.endpoint"
  | "database.connect"
  | "database.query"
  | "oauth.client_metadata"
  | "response.body"
  | "workspace.session"
  | "workspace.organizations"
  | "workspace.role"
  | "files.session"
  | "files.organizations"
  | "files.role"
  | "files.folders"
  | "files.schema"
  | "files.list"
  | "asset.session"
  | "asset.query";

export type OperationSpan = {
  name: TraceOperation;
  span?: Span;
  parent?: OperationSpan;
  started: number;
  run<T>(work: () => T): T;
  end(error?: unknown): void;
};
export type RequestTrace = {
  root?: Span;
  active: Set<OperationSpan>;
  closed: boolean;
  start(name: TraceOperation, parent?: OperationSpan): OperationSpan;
};
type TraceContext = { trace: RequestTrace; operation?: OperationSpan };

// The Worker entry and Next route bundles have separate module instances. Share
// the request storage, never a client or pending export, across those bundles.
const key = Symbol.for("tidy.posthog.trace-context");
const globals = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<TraceContext> };
export const traceStorage = (globals[key] ??= new AsyncLocalStorage<TraceContext>());

export function traceDetails() {
  const trace = traceStorage.getStore()?.trace;
  return {
    trace_id: trace?.root?.traceparent()?.split("-")[1],
    operations: trace ? [...new Set([...trace.active].map((item) => item.name))] : [],
  };
}

export function startOperation(name: TraceOperation): OperationSpan {
  const context = traceStorage.getStore();
  if (context && !context.trace.closed) {
    // A callback can inherit the context of a connection that has already
    // completed. Attach subsequent work to its nearest still-active ancestor.
    let parent = context.operation;
    while (parent && !context.trace.active.has(parent)) parent = parent.parent;
    return context.trace.start(name, parent);
  }
  return { name, started: Date.now(), run: (work) => work(), end: () => {} };
}

export async function traceOperation<T>(name: TraceOperation, work: () => Promise<T>): Promise<T> {
  const operation = startOperation(name);
  try {
    const result = await operation.run(work);
    operation.end();
    return result;
  } catch (error) {
    operation.end(error);
    throw error;
  }
}

export function safeErrorCode(error: unknown): string | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  )
    return;
  // SQLSTATE or known transport codes. Never send messages, query text or causes.
  if (
    /^[0-9A-Z]{5}$/.test(error.code) ||
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EPIPE",
      "EAI_AGAIN",
      "ABORT_ERR",
    ].includes(error.code)
  )
    return error.code;
}
