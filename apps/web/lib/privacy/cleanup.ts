import "server-only";
import { db } from "@/lib/db";
import { designBucket } from "@/lib/storage/design-objects";
import { feedbackBucket } from "@/lib/feedback/storage";
import { runnerRequest } from "@/lib/agents/runner-client";
import { maintainConsentRecords } from "./consent-store";
import { analyticsStorageEnabled } from "@/lib/analytics/store";
import { maintainProductAnalytics } from "@/lib/analytics/store";
import { maintainMcpConsentRecords } from "./mcp-consent";

type CleanupJob = {
  id: string;
  kind: "avatar" | "feedback" | "runner" | "posthog" | "posthog-review";
  subject: string;
  attempts: number;
};
export async function eraseAvatarPrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
    if (!page.truncated) return;
    if (!page.cursor || page.cursor === cursor) throw new Error("Avatar listing did not advance");
    cursor = page.cursor;
  } while (true);
}

export async function eraseExternalData(job: Pick<CleanupJob, "kind" | "subject">) {
  if (job.kind === "posthog-review") {
    // Selective withdrawal, expired consent and anonymous records require review.
    // Never use a person API's empty result as evidence of erasure.
    return "awaiting-verification";
  } else if (job.kind === "avatar") {
    const bucket = designBucket();
    if (!bucket) throw new Error("Avatar storage unavailable");
    if (job.subject.endsWith("/")) await eraseAvatarPrefix(bucket, job.subject);
    else await bucket.delete(job.subject); // Jobs created by the previous release.
  } else if (job.kind === "feedback") {
    await feedbackBucket().delete(job.subject);
  } else if (job.kind === "runner") {
    await runnerRequest(job.subject, "erase");
  } else {
    if (process.env.PRIVACY_POSTHOG_MODE === "manual") return "awaiting-verification";
    const host = process.env.PRIVACY_POSTHOG_HOST;
    const project = process.env.PRIVACY_POSTHOG_PROJECT_ID;
    const token = process.env.PRIVACY_POSTHOG_API_KEY;
    // Operators can explicitly attest that this installation never used PostHog.
    if (process.env.PRIVACY_POSTHOG_DISABLED === "1") {
      if (
        process.env.NEXT_PUBLIC_POSTHOG_ENABLED === "1" ||
        process.env.POSTHOG_SERVER_ERRORS_ENABLED === "1" ||
        process.env.POSTHOG_MCP_ANALYTICS_ENABLED === "1"
      )
        throw new Error("PostHog cleanup cannot be disabled while collection is enabled");
      return "complete";
    }
    if (!host || !project || !token) throw new Error("PostHog erasure is not configured");
    const url = new URL(`/api/projects/${encodeURIComponent(project)}/persons/bulk_delete/`, host);
    if (url.protocol !== "https:") throw new Error("PostHog erasure requires HTTPS");
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        distinct_ids: [job.subject],
        delete_events: true,
        delete_recordings: true,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("PostHog erasure request failed");
    const result = (await response.json()) as {
      events_queued_for_deletion?: boolean;
      recordings_queued_for_deletion?: boolean;
      deletion_errors?: unknown[];
    };
    if (
      result.events_queued_for_deletion !== true ||
      result.recordings_queued_for_deletion !== true ||
      !Array.isArray(result.deletion_errors) ||
      result.deletion_errors.length
    )
      throw new Error("PostHog erasure was not accepted");
    // A 202 acknowledges the request, not erasure. Retain the identifier until
    // an operator verifies provider completion and records the outcome privately.
    return "awaiting-verification";
  }
  return "complete";
}

export async function processPrivacyCleanup(limit = 1) {
  await maintainConsentRecords();
  await maintainMcpConsentRecords();
  let completed = 0,
    failed = 0;
  for (let index = 0; index < limit; index++) {
    // Atomic lease permits multiple workers and recovers from worker termination.
    const job = (
      await db.query<CleanupJob>(`update "privacyCleanup" set
      "nextAttemptAt"=now()+interval '5 minutes', attempts=attempts+1
      where id=(select id from "privacyCleanup" where "nextAttemptAt"<=now()
        order by "nextAttemptAt" for update skip locked limit 1) returning *`)
    ).rows[0];
    if (!job) break;
    try {
      const outcome = await eraseExternalData(job);
      if (outcome === "awaiting-verification") {
        await db.query(
          `update "privacyCleanup" set "nextAttemptAt"='infinity' where id=$1 and attempts=$2`,
          [job.id, job.attempts],
        );
        console.info(
          JSON.stringify({ event: "privacy_cleanup_awaiting_verification", kind: job.kind }),
        );
        continue;
      }
      await db.query('delete from "privacyCleanup" where id=$1 and attempts=$2', [
        job.id,
        job.attempts,
      ]);
      completed++;
    } catch {
      failed++;
      await db.query(
        `update "privacyCleanup" set "nextAttemptAt"=now()+($2*interval '1 minute') where id=$1 and attempts=$3`,
        [job.id, Math.min(1440, 5 * 2 ** Math.min(job.attempts, 8)), job.attempts],
      );
      console.error(
        JSON.stringify({ event: "privacy_cleanup_failed", kind: job.kind, attempts: job.attempts }),
      );
    }
  }
  const pending = (
    await db.query<{ pending: number; overdue: number }>(`select count(*)::int as pending,
    count(*) filter (where "createdAt"<now()-interval '1 day')::int as overdue
    from "privacyCleanup" where kind in ('posthog','posthog-review')
      and ("nextAttemptAt"<=now() or attempts>0)`)
  ).rows[0];
  if (pending.pending)
    console.warn(JSON.stringify({ event: "privacy_review_pending", ...pending }));
  // Optional analytics maintenance must not delay or prevent existing erasure work.
  if (analyticsStorageEnabled())
    try {
      await maintainProductAnalytics();
    } catch {
      console.error(JSON.stringify({ event: "product_analytics_maintenance_failed" }));
      throw new Error("Product analytics maintenance did not complete.");
    }
  return { completed, failed };
}
