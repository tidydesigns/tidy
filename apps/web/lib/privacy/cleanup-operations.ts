import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

// Operator-only; no public HTTP endpoint can mark erasure complete.
export async function completePostHogReview(
  client: Pick<PoolClient, "query">,
  id: string,
  reference: string,
) {
  if (!/^[a-f0-9-]{36}$/.test(id) || !reference.trim() || reference.length > 500)
    throw new Error(
      "Supply the job UUID and a nonempty completion-evidence reference (up to 500 characters)",
    );
  await client.query("begin");
  try {
    const job = (
      await client.query<{ kind: string; subject: string }>(
        `select kind,subject from "privacyCleanup" where id=$1 and kind in ('posthog','posthog-review') for update`,
        [id],
      )
    ).rows[0];
    if (!job) throw new Error("Pending PostHog review not found");
    await client.query(
      `insert into "privacyCleanupReceipt" (id,kind,"subjectHash",reference) values ($1,$2,$3,$4)`,
      [id, job.kind, createHash("sha256").update(job.subject).digest("hex"), reference.trim()],
    );
    await client.query('delete from "privacyCleanup" where id=$1', [id]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
