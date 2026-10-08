import { AsyncLocalStorage } from "node:async_hooks";
import { ConnectorError } from "@/lib/connectors/error";
import { requestSignal } from "@/lib/request-lifecycle";

type Budget = { requests: number; bytes: number; signal: AbortSignal };
const storage = new AsyncLocalStorage<Budget>();
export function boundedLinearOperation<A extends unknown[], T>(work: (...args: A) => Promise<T>) {
  return (...args: A) => {
    if (storage.getStore()) return work(...args);
    const parent = requestSignal();
    return storage.run(
      {
        requests: 0,
        bytes: 0,
        signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(parent ? [parent] : [])]),
      },
      () => work(...args),
    );
  };
}
export function linearRequestSignal() {
  const budget = storage.getStore(),
    parent = requestSignal();
  if (budget && ++budget.requests > 12)
    throw new ConnectorError("Linear request work limit reached. Try a smaller operation.", 422);
  const signal = AbortSignal.any([
    AbortSignal.timeout(10_000),
    ...(budget ? [budget.signal] : []),
    ...(parent ? [parent] : []),
  ]);
  signal.throwIfAborted();
  return signal;
}
export function consumeLinearBytes(bytes: number) {
  const budget = storage.getStore();
  if (budget && (budget.bytes += bytes) > 4_000_000)
    throw new ConnectorError("Linear response work limit reached. Try a smaller operation.", 422);
}
