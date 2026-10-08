import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import {
  canReadAttachment,
  FeedbackError,
  UUID,
  validateImages,
  validateSignature,
} from "./validation";

export const FEEDBACK_UPLOAD_LIMITS = { hourly: 20, retained: 100, bytes: 100_000_000 } as const;

export type Attachment = { key: string; name: string; type: string; size: number };
export function feedbackBucket() {
  try {
    const bucket = (getCloudflareContext().env as CloudflareEnv & { FEEDBACK_IMAGES?: R2Bucket })
      .FEEDBACK_IMAGES;
    if (bucket) return bucket;
  } catch {
    /* Next development without a Workers runtime. */
  }
  throw new FeedbackError(
    "Image uploads are not configured yet. You can still send text feedback.",
    503,
  );
}

export async function storeAttachments(userId: string, id: string, files: File[]) {
  if (!UUID.test(id)) throw new FeedbackError("Invalid upload ID.");
  validateImages(files);
  const uploads = await Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      validateSignature(file.type, bytes);
      return { file, bytes };
    }),
  );
  const digest = createHash("sha256");
  for (const { file, bytes } of uploads)
    digest.update(JSON.stringify([file.name, file.type, file.size])).update(bytes);
  const fingerprint = digest.digest("hex");
  const bucket = feedbackBucket();
  const client = await db.connect();
  const keys: string[] = [];
  let committing = false;
  try {
    await client.query("begin");
    // Serialise per-user uploads so the quota and retries remain atomic.
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `feedback:${userId}`,
    ]);
    // Reconciliation and every owner contend on the same UUID before publishing bytes.
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `feedback-upload:${id.toLowerCase()}`,
    ]);
    const user = await client.query(
      'select "id" from "user" where "id"=$1 and "emailVerified"=true for share',
      [userId],
    );
    if (!user.rowCount) throw new FeedbackError("Verify your email before uploading images.", 403);
    const existing = await client.query<{ fingerprint: string; attachments: Attachment[] }>(
      'select fingerprint, attachments from "feedbackUpload" where id=$1 and "userId"=$2',
      [id, userId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].fingerprint !== fingerprint)
        throw new FeedbackError("Attachments changed. Please try again.", 409);
      await client.query("commit");
      return existing.rows[0].attachments;
    }
    const count = await client.query<{ count: string }>(
      'select count(*) from "feedbackUpload" where "userId"=$1 and "createdAt" > now() - interval \'1 hour\'',
      [userId],
    );
    if (Number(count.rows[0].count) >= FEEDBACK_UPLOAD_LIMITS.hourly)
      throw new FeedbackError("Too many image uploads. Please try again later.", 429);
    const usage = (
      await client.query<{ retained: number; bytes: string }>(
        `select count(*)::int as retained,
      coalesce(sum((select sum((image->>'size')::bigint) from jsonb_array_elements(attachments) image)),0)::text as bytes
      from "feedbackUpload" where "userId"=$1`,
        [userId],
      )
    ).rows[0];
    if (
      usage.retained >= FEEDBACK_UPLOAD_LIMITS.retained ||
      Number(usage.bytes) + files.reduce((sum, file) => sum + file.size, 0) >
        FEEDBACK_UPLOAD_LIMITS.bytes
    ) {
      throw new FeedbackError(
        "Your image feedback storage limit has been reached. You can still send text feedback.",
        429,
      );
    }
    const attachments = uploads.map(({ file }, index) => ({
      key: `feedback/${id}/${index}`,
      name: file.name.slice(0, 200),
      type: file.type,
      size: file.size,
    }));
    // Claim the UUID before touching R2; another user's UUID cannot overwrite an object.
    await client.query(
      'insert into "feedbackUpload" (id, "userId", fingerprint, attachments) values ($1,$2,$3,$4)',
      [id, userId, fingerprint, JSON.stringify(attachments)],
    );
    for (const [index, { bytes }] of uploads.entries()) {
      keys.push(attachments[index].key);
      await bucket.put(attachments[index].key, bytes, {
        httpMetadata: { contentType: attachments[index].type },
      });
    }
    committing = true;
    await client.query("commit");
    return attachments;
  } catch (error) {
    // A failed COMMIT response can still mean it committed. Preserve objects in that case.
    // Clean failed writes while our UUID lock is still held: a retry cannot publish
    // replacement bytes between rollback and this delete.
    if (!committing && keys.length)
      await bucket.delete(keys).catch(() => console.error("Feedback upload cleanup failed"));
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function readAttachment(
  user: { id: string; email: string; emailVerified: boolean },
  id: string,
  index: number,
) {
  const actor = (
    await db.query<{ id: string; email: string; emailVerified: boolean }>(
      'select "id","email","emailVerified" from "user" where "id"=$1 and "emailVerified"=true',
      [user.id],
    )
  ).rows[0];
  if (!actor) return null;
  const upload = (
    await db.query<{ userId: string; attachments: Attachment[] }>(
      'select "userId",attachments from "feedbackUpload" where id=$1',
      [id],
    )
  ).rows[0];
  if (
    !upload ||
    !canReadAttachment(upload.userId, actor, process.env.FEEDBACK_REVIEWER_EMAILS ?? "")
  )
    return null;
  const attachment = upload.attachments[index];
  if (!attachment) return null;
  const object = await feedbackBucket().get(attachment.key);
  return object ? { object, type: attachment.type } : null;
}
