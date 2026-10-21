import "server-only";
import { unstable_rethrow } from "next/navigation";
import { createErrorReporter } from "./posthog-server";

const reported = new WeakSet<object>();

/** Report the original caught value before selecting public response copy. */
export function reportHandledError(
  error: unknown,
  operation: "action.failed" | "files.manage" = "action.failed",
) {
  unstable_rethrow(error);
  if (error && typeof error === "object") {
    if (reported.has(error)) return;
    reported.add(error);
  }
  try {
    void createErrorReporter()(error, {
      source: "operation",
      event: "operation_failed",
      operation,
      phase: "action",
    }).catch(() => {});
  } catch {
    /* Optional diagnostics cannot replace the operation's error. */
  }
}
