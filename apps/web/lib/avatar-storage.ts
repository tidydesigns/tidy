import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { designBucket } from "@/lib/storage/design-objects";
import { avatarBytes, avatarObjectKey, avatarPath, type AvatarKind } from "@/lib/avatars";
import { FeedbackError } from "@/lib/feedback/validation";
import { can } from "@/lib/organizations/roles";

export async function requireAvatarAccess(
  userId: string,
  kind: AvatarKind,
  id: string,
  write: boolean,
) {
  if (kind === "user" && userId === id) return;
  if (kind === "user") {
    if (!write) {
      const shared = await db.query(
        `select 1 from "member" a join "member" b on a."organizationId" = b."organizationId" where a."userId" = $1 and b."userId" = $2 limit 1`,
        [userId, id],
      );
      if (shared.rows.length) return;
    }
  } else {
    const member = await db.query<{ role: string }>(
      'select "role" from "member" where "userId" = $1 and "organizationId" = $2',
      [userId, id],
    );
    if (can(member.rows[0]?.role, write ? "manage" : "view")) return;
  }
  throw new FeedbackError("You do not have access to this image.", write ? 403 : 404);
}

const fields = { user: '"image"', organization: '"logo"' } as const;

export async function currentAvatar(kind: AvatarKind, id: string) {
  const result = await db.query<{ image: string | null }>(
    `select ${fields[kind]} as image from "${kind}" where id = $1`,
    [id],
  );
  return result.rows[0]?.image ?? null;
}

export async function updateAvatar(
  userId: string,
  kind: AvatarKind,
  id: string,
  file: File | null,
) {
  await requireAvatarAccess(userId, kind, id, true);
  const bytes = file ? await avatarBytes(file) : null;
  const bucket = designBucket();
  if (!bucket)
    throw new FeedbackError("Image uploads are unavailable. Please try again later.", 503);
  const url = file ? `${avatarPath(kind, id)}?v=${randomUUID()}` : null;
  const key = avatarObjectKey(url, kind, id);
  const client = await db.connect();
  let previous: string | null = null;
  let committing = false;
  try {
    await client.query("begin");
    // Serialize replacements so only the image this update supersedes is deleted.
    const result = await client.query<{ image: string | null }>(
      `select ${fields[kind]} as image from "${kind}" where id = $1 for update`,
      [id],
    );
    if (!result.rows.length) throw new FeedbackError("Image owner not found.", 404);
    if (kind === "organization") {
      const member = await client.query<{ role: string }>(
        'select "role" from "member" where "userId" = $1 and "organizationId" = $2 for share',
        [userId, id],
      );
      if (!can(member.rows[0]?.role, "manage"))
        throw new FeedbackError("You cannot change this organization icon.", 403);
    }
    previous = avatarObjectKey(result.rows[0].image, kind, id);
    if (key && bytes && file)
      await bucket.put(key, bytes, { httpMetadata: { contentType: file.type } });
    await client.query(
      `update "${kind}" set ${fields[kind]} = $2${kind === "user" ? ', "updatedAt" = now()' : ""} where id = $1`,
      [id, url],
    );
    committing = true;
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    // A lost COMMIT response may still have persisted the URL. Keep its object.
    if (!committing && key)
      await bucket.delete(key).catch(() => console.error("Avatar upload cleanup failed"));
    throw error;
  } finally {
    client.release();
  }
  if (previous)
    await bucket.delete(previous).catch(() => console.error("Previous avatar cleanup failed"));
  return url;
}
