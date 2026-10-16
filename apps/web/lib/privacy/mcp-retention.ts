import "server-only";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";

/** One service identifier per UTC day, shared by all unlinked calls. */
export const mcpMonitoringId = (timestamp: Date) =>
  `mcp:service:${timestamp.toISOString().slice(0, 10)}`;

/** Register the day's provider erasure before delivery; no account data is stored. */
export async function queueMcpMonitoringErasure(timestamp: Date) {
  const distinctId = mcpMonitoringId(timestamp);
  const id = createHash("sha256").update(distinctId).digest("hex").slice(0, 32);
  const day = timestamp.toISOString().slice(0, 10);
  await db.query(
    `insert into "privacyCleanup" (id,kind,subject,"nextAttemptAt")
     values ($1,'posthog-review',$2,(($3::date + 90)::timestamp at time zone 'UTC'))
     on conflict (id) do nothing`,
    [id, JSON.stringify({ reason: "mcp-monitoring-retention", distinctIds: [distinctId] }), day],
  );
}
