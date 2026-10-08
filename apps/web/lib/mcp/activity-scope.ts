import { db } from "@/lib/db";
import type { ActivityDetails } from "@/lib/realtime/agent-activity";

export type ActivityScope = ActivityDetails & { fileId: string; importId?: string };
/** Only compact routing data crosses this query; staged trees stay in Postgres. */
export async function resolveActivityScope(
  userId: string,
  input: Record<string, unknown>,
): Promise<ActivityScope | null> {
  if (typeof input.import_id === "string") {
    const row = (
      await db.query<{ fileId: string | null; importId: string }>(
        `select i."fileId", i."id" as "importId" from "designImport" i
      join "member" m on m."organizationId" = i."organizationId" and m."userId" = $2
      join "designFile" f on f."id" = i."fileId" and f."archivedAt" is null
      where i."id" = $1 and i."userId" = $2 and i."expiresAt" > now() and i."status" in ('staging', 'committed')
        and ($3::text is null or i."organizationId" = $3)`,
        [input.import_id, userId, input.organization_id ?? null],
      )
    ).rows[0];
    return row?.fileId ? { fileId: row.fileId, importId: row.importId } : null;
  }
  if (typeof input.file_id === "string") {
    const row = (
      await db.query<{ fileId: string }>(
        `select f."id" as "fileId" from "designFile" f
      join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2
      where f."id" = $1 and f."archivedAt" is null`,
        [input.file_id, userId],
      )
    ).rows[0];
    return row
      ? { ...row, nodeIds: typeof input.node_id === "string" ? [input.node_id] : undefined }
      : null;
  }
  if (typeof input.review_id === "string") {
    const row = (
      await db.query<{ fileId: string }>(
        `select r."fileId" from "githubReview" r
      join "designFile" f on f."id" = r."fileId" and f."archivedAt" is null
      join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2 where r."id" = $1`,
        [input.review_id, userId],
      )
    ).rows[0];
    return row ?? null;
  }
  return null;
}
