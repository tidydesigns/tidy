import { AsyncLocalStorage } from "node:async_hooks";

export type RequestPhase =
  | "routing"
  | "auth_initialization"
  | "auth_api"
  | "auth_endpoint"
  | "database_connect"
  | "database_query"
  | "client_metadata"
  | "body"
  | "rate_limit"
  | "response_body";
type Lifecycle = { signal: AbortSignal; phases: Map<symbol, RequestPhase> };
// OpenNext and the Worker entry are compiled separately. Share storage, never
// pending I/O, so both bundles see the same invocation's cancellation signal.
const key = Symbol.for("tidy.request-lifecycle");
const globals = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<Lifecycle> };
const storage = (globals[key] ??= new AsyncLocalStorage<Lifecycle>());

export const requestSignal = () => storage.getStore()?.signal;
export const requestPhases = () => [...new Set(storage.getStore()?.phases.values() ?? [])];
export function assertRequestActive() {
  requestSignal()?.throwIfAborted();
}
export function runWithRequestSignal<T>(signal: AbortSignal, work: () => Promise<T>) {
  return storage.run({ signal, phases: new Map() }, work);
}
export function startRequestPhase(phase: RequestPhase) {
  assertRequestActive();
  const phases = storage.getStore()?.phases;
  const id = Symbol(phase);
  phases?.set(id, phase);
  return () => {
    phases?.delete(id);
  };
}
export async function traceRequestPhase<T>(phase: RequestPhase, work: () => Promise<T>) {
  const finish = startRequestPhase(phase);
  try {
    return await work();
  } finally {
    finish();
  }
}
export async function waitForSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const canceled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new DOMException("Request canceled", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  // Attach a rejection handler to work even if cancellation wins first.
  try {
    return await Promise.race([work, canceled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
