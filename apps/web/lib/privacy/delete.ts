import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { avatarObjectKey } from "@/lib/avatars";
import { designBucket } from "@/lib/storage/design-objects";
import { runnerConfigured } from "@/lib/agents/runner-client";
import { lockPrivacyAccount, PrivacyError } from "./access";
import { checkDeletionOwnership } from "./deletion-eligibility";

export const DELETED_USER = "tidy-deleted-user";
export async function deleteAccount(userId: string, sessionId: string, confirmation: string) {
  if (userId === DELETED_USER) throw new PrivacyError("Account unavailable.", 403);
  const client = await db.connect();
  try {
    await client.query("begin");
    // Membership mutations take organization locks before user locks. Use the same
    // order and lock all current organizations deterministically to prevent deadlocks.
    const organizations = (
      await client.query<{ organizationId: string }>(
        'select "organizationId" from member where "userId"=$1 order by "organizationId"',
        [userId],
      )
    ).rows;
    for (const { organizationId } of organizations) {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [organizationId]);
      await client.query("select id from organization where id=$1 for update", [organizationId]);
    }
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `agent-personal:${userId}`,
    ]);
    const user = await lockPrivacyAccount(client, userId, sessionId);
    if (confirmation !== user.email)
      throw new PrivacyError("Enter your email address exactly to confirm deletion.");
    // Recheck under the transaction's organization locks: the preflight is only guidance.
    await checkDeletionOwnership(userId, client);
    const enqueue = async (kind: string, subject: string) =>
      client.query('insert into "privacyCleanup" (id,kind,subject) values ($1,$2,$3)', [
        randomUUID(),
        kind,
        subject,
      ]);
    const avatar = avatarObjectKey(user.image, "user", userId);
    // Include older replacements whose best-effort cleanup failed. Preserve
    // support for installations without object storage and legacy outbox jobs.
    if (avatar || designBucket())
      await enqueue("avatar", `avatars/user/${encodeURIComponent(userId)}/`);
    const uploads = (
      await client.query<{ attachments: { key: string }[] }>(
        'select attachments from "feedbackUpload" where "userId"=$1',
        [userId],
      )
    ).rows;
    for (const upload of uploads)
      for (const attachment of upload.attachments) await enqueue("feedback", attachment.key);
    const agent = await client.query('select id from "agentConnection" where "userId"=$1', [
      userId,
    ]);
    // Login touches the runner before committing its connection row. A failed
    // login transaction can therefore leave private files without a DB record.
    if (agent.rowCount || runnerConfigured()) await enqueue("runner", userId);
    // Queue even if analytics is currently off: older consent may have created a profile.
    await enqueue("posthog", userId);
    for (const table of ["designFile", "designFolder", "designCommentThread", "githubReview"]) {
      await client.query(`update "${table}" set "createdBy"=$2 where "createdBy"=$1`, [
        userId,
        DELETED_USER,
      ]);
    }
    // Remove free-text personal contributions; retain other members' replies.
    await client.query('delete from "designCommentMessage" where "authorId"=$1', [userId]);
    await client.query('delete from "githubFeedback" where "authorId"=$1', [userId]);
    await client.query('delete from "designImport" where "userId"=$1', [userId]);
    await client.query('delete from "designRealtimeOperation" where "userId"=$1', [userId]);
    for (const table of ["designFileVersion", "designFileRestore"]) {
      await client.query(`update "${table}" set "createdByName"=null where "createdBy"=$1`, [
        userId,
      ]);
    }
    // Agent outbox payloads can contain full message copies. Delete the affected
    // thread's replay cache; current durable messages remain the source of truth.
    await client.query(
      `delete from "agentEvent" where "threadId" in
      (select "threadId" from "agentMessage" where "userId"=$1 union select "threadId" from "agentRun" where "ownerId"=$1)`,
      [userId],
    );
    await client.query('delete from "agentMessage" where "userId"=$1', [userId]);
    await client.query("delete from invitation where lower(email)=lower($1)", [user.email]);
    // Verification records aren't FK-linked. Remove user/email-bound records and
    // OAuth authorization codes containing this subject, including pending resets.
    await client.query(
      `delete from verification where identifier=$1 or identifier=$2 or value=$1
      or value like $3 or value like $4 or identifier=$5`,
      [
        userId,
        user.email,
        `%"userId":"${userId.replace(/[\\%_]/g, "\\$&")}"%`,
        `%"email":"${user.email.replace(/[\\%_]/g, "\\$&")}"%`,
        `privacy-attempt:${userId}`,
      ],
    );
    // Cascades revoke all sessions, OAuth consents/tokens, connections, vault
    // credentials, memberships, uploads and agent runs in the same transaction.
    await client.query('delete from "user" where id=$1', [userId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
