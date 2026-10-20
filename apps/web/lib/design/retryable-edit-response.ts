import { serverErrorCategory } from "../posthog-server";

const retryableCategories = new Set([
  "connection_reset",
  "connection_refused",
  "connection_timeout",
  "dns_failure",
  "database_connection",
  "database_connection_capacity",
  "database_query_canceled",
  "database_deadlock",
  "database_serialization_conflict",
  "timeout",
]);

export function retryableEditResponse(error: unknown): Response | null {
  if (!retryableCategories.has(serverErrorCategory(error))) return null;
  return Response.json(
    { error: "Could not save the edit yet. Retrying." },
    { status: 503, headers: { "Cache-Control": "private, no-store", "Retry-After": "1" } },
  );
}
