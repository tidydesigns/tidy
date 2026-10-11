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
