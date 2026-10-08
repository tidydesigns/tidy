import { createErrorReporter } from "./posthog-server";
import { traceOperation } from "./trace-context";

type Operation =
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

/** Correlate a bounded operation name with the Worker ray, never arguments or SQL. */
export async function observeOperation<T>(
  headers: Pick<Headers, "get">,
  operation: Operation,
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const report = createErrorReporter(headers);
  const details = { operation, ray: headers.get("cf-ray") };
  const elapsed = () => Math.round(performance.now() - started);
  console.info(JSON.stringify({ event: "operation_started", ...details }));
  const pending = setTimeout(() => {
    console.warn(JSON.stringify({ event: "operation_stalled", ...details, elapsedMs: elapsed() }));
    void report(new Error("operation_stalled"), {
      source: "operation",
      event: "operation_stalled",
      operation,
      elapsedMs: elapsed(),
    });
  }, 5000);
  try {
    const result = await traceOperation(operation, run);
    console.info(
      JSON.stringify({ event: "operation_completed", ...details, elapsedMs: elapsed() }),
    );
    return result;
  } catch (error) {
    console.error(JSON.stringify({ event: "operation_failed", ...details, elapsedMs: elapsed() }));
    throw error;
  } finally {
    clearTimeout(pending);
  }
}
