import { unstable_rethrow } from "next/navigation";
import { createErrorReporter } from "./posthog-server";

type Availability = "settings.agents_availability" | "settings.billing_availability";

/** Optional tab checks fail independently, without changing authentication or authorization. */
export async function settingsAvailability(
  operation: Availability,
  check: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await check();
  } catch (error) {
    unstable_rethrow(error);
    // Log only the bounded operation name; errors may contain SQL or credentials.
    console.error(JSON.stringify({ event: "operation_failed", operation }));
    try {
      void createErrorReporter()(error, {
        source: "operation",
        event: "operation_failed",
        operation,
        route: "/settings",
      }).catch(() => {});
    } catch {
      // Optional diagnostics must not prevent the remaining settings from loading.
    }
    return false;
  }
}
