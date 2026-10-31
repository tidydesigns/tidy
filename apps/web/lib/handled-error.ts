import "server-only";
import { unstable_rethrow } from "next/navigation";
import { createErrorReporter } from "./posthog-server";

const reported = new WeakSet<object>();

/** Report the original caught value before selecting public response copy. */
export function reportHandledError(
  error: unknown,
  operation:
    | "action.failed"
    | "files.manage"
    | "mcp.admission"
    | "mcp.create_import" = "action.failed",
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
      ...(operation.startsWith("mcp.")
        ? { route: "/api/mcp", method: "POST", phase: "handler" }
        : { phase: "action" }),
    }).catch(() => {});
  } catch {
    /* Optional diagnostics cannot replace the operation's error. */
  }
}
