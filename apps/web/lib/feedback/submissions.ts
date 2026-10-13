import "server-only";
import { db } from "@/lib/db";
import { requireVerifiedUser } from "@/lib/security/user-authority";
import { PrivacyError } from "@/lib/privacy/access";
export async function storeFeedback(userId: string, id: string, category: string, message: string) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await requireVerifiedUser(client, userId, true);
    const result = await client.query(
      `insert into "feedbackSubmission" (id,"userId",category,message)
      values ($1,$2,$3,$4) on conflict(id) do update set id=excluded.id
      where "feedbackSubmission"."userId"=excluded."userId" and "feedbackSubmission".category=excluded.category and "feedbackSubmission".message=excluded.message returning id`,
      [id, userId, category, message],
    );
    if (!result.rowCount)
      throw new PrivacyError("Feedback changed. Please reopen the form and retry.", 409);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
