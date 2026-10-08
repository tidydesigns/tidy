// Auth and the general Worker boundary share one invocation lifecycle so
// database cancellation and phase diagnostics remain consistent.
export {
  assertRequestActive,
  requestSignal,
  requestPhases,
  runWithRequestSignal,
  waitForSignal,
  startRequestPhase as startAuthOperation,
  traceRequestPhase as traceAuthOperation,
} from "../request-lifecycle";
import { requestSignal } from "../request-lifecycle";

export function onRequestCanceled(cancel: () => void) {
  const signal = requestSignal();
  if (!signal) return () => {};
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  return () => {
    signal.removeEventListener("abort", cancel);
  };
}
