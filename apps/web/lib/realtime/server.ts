import { fileEventsQuery } from "./events";
import { requestWork } from "@/lib/request-work";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { db } from "@/lib/db";
import { signTicket } from "./ticket";
import type { FileEvent } from "./protocol";
import { withDeadline } from "@/lib/deadline";
import { agentActivitySchema, activityWorking, type AgentActivity } from "./agent-activity";
import { afterDatabaseCommit } from "@/lib/database-scope";

export async function publishAgentActivity(input: AgentActivity) {
  const activity = agentActivitySchema.parse(input);
  if (
    !activityWorking(activity) &&
    afterDatabaseCommit(`activity:${activity.id}`, () => publishAgentActivity(activity))
  )
    return;
  try {
    let context;
    try {
      context = getCloudflareContext();
    } catch {
      /* Local relay below. */
    }
    if (context?.env.FILE_ROOMS) {
      await withDeadline(
        context.env.FILE_ROOMS.getByName(activity.fileId).activity(activity),
        1000,
        "Agent activity relay timed out.",
      );
    } else if (process.env.BELLA_REALTIME_URL && process.env.BETTER_AUTH_SECRET) {
      const authorization = await signTicket(
        {
          purpose: "file-room",
          fileId: activity.fileId,
          organizationId: "internal",
          userId: "internal",
          name: "",
          image: null,
          sessionId: crypto.randomUUID(),
          authSessionId: "internal",
          expiresAt: Date.now() + 30_000,
        },
        process.env.BETTER_AUTH_SECRET,
      );
      await fetch(new URL("/__activity", process.env.BELLA_REALTIME_URL), {
        method: "POST",
        headers: { Authorization: `Bearer ${authorization}`, "Content-Type": "application/json" },
        body: JSON.stringify(activity),
        signal: AbortSignal.timeout(1000),
      });
    }
  } catch {
    /* Activity is advisory; never fail or retry the underlying tool. */
  }
}

export async function realtimeSchemaReady() {
  return requestWork("realtimeSchemaReady", async () => {
    const result = await db.query<{ ready: boolean }>(
      `select to_regclass('public."designRealtimeState"') is not null and to_regclass('public."designRealtimeOperation"') is not null and to_regclass('public."designRealtimeEvent"') is not null and to_regclass('public."designRealtimeProperty"') is not null and exists(select 1 from information_schema.columns where table_schema='public' and table_name='designRealtimeOperation' and column_name='requestRevision') as ready`,
    );
    return result.rows[0]?.ready === true;
  });
}
export async function fileEvents(fileId: string, after: number): Promise<FileEvent[]> {
  const result = await db.query<{ sequence: string; kind: FileEvent["kind"] }>(fileEventsQuery, [
    fileId,
    after,
  ]);
  return result.rows.map((row) => ({ ...row, sequence: Number(row.sequence) }));
}
export async function publishFileChanges(fileId: string) {
  if (afterDatabaseCommit(`file:${fileId}`, () => publishFileChanges(fileId))) return;
  // A failed immediate relay never rolls back an already committed edit. The
  // room's recovery alarm reads the durable outbox and retries independently.
  try {
    let context;
    try {
      context = getCloudflareContext();
    } catch {
      /* Next dev uses the local room Worker. */
    }
    if (context?.env.FILE_ROOMS) {
      // The edit is already committed. A stuck room must not hold its HTTP
      // acknowledgment (and checked-out database client) indefinitely.
      await withDeadline(
        context.env.FILE_ROOMS.getByName(fileId).sync(fileId),
        3000,
        "Live file relay timed out.",
      );
    } else if (process.env.BELLA_REALTIME_URL && process.env.BETTER_AUTH_SECRET) {
      const authorization = await signTicket(
        {
          purpose: "file-room",
          fileId,
          organizationId: "internal",
          userId: "internal",
          name: "",
          image: null,
          sessionId: crypto.randomUUID(),
          authSessionId: "internal",
          expiresAt: Date.now() + 30_000,
        },
        process.env.BETTER_AUTH_SECRET,
      );
      const response = await fetch(new URL("/__relay", process.env.BELLA_REALTIME_URL), {
        method: "POST",
        headers: { Authorization: `Bearer ${authorization}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`Relay returned ${response.status}`);
    }
  } catch {
    console.error("Live file relay failed; durable events remain available.");
  }
}
