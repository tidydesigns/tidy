import "server-only";
import type { PoolClient } from "pg";
import { db } from "@/lib/db";
import { VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import type { StoredImage } from "@/lib/storage/design-objects";
import { reserveImageOperation } from "./image-budget";
import { withImageReadCapacity } from "./image-capacity";

/** Current authority precedes cache, conditional responses and all private bytes. */
export async function withPrivateImageAccess<T>(
  userId: string,
  id: string,
  kind: "asset" | "thumbnail",
  version: string | null,
  work: (client: PoolClient, image: StoredImage & { organizationId: string }) => Promise<T>,
): Promise<T | null> {
  if (!id || id.length > 120 || (version !== null && version.length > 512)) return null;
  const sql =
    kind === "asset"
      ? `select a."mimeType",a."objectKey",a."sha256",greatest(a."byteSize",octet_length(a."body"))::float8 as "byteSize",a."organizationId"
      from "designAsset" a join "member" m on m."organizationId"=a."organizationId" and m."userId"=$2 and m."role" in ${VIEW_ROLES_SQL}
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where a."id"=$1 and ($3::text is null) and ($4::text is null or a."organizationId"=$4)`
      : `select t."mimeType",t."objectKey",t."sha256",greatest(t."byteSize",octet_length(t."body"))::float8 as "byteSize",f."organizationId"
      from "designFileThumbnail" t join "designFile" f on f."id"=t."fileId"
      join "member" m on m."organizationId"=f."organizationId" and m."userId"=$2 and m."role" in ${VIEW_ROLES_SQL}
      join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where f."id"=$1 and ($3::text is null or t."version"=$3) and ($4::text is null or f."organizationId"=$4)`;
  const discovered = await db.query<StoredImage & { organizationId: string }>(sql, [
    id,
    userId,
    version,
    null,
  ]);
  if (discovered.rows.length !== 1) return null;
  const organizationId = discovered.rows[0]!.organizationId;
  await reserveImageOperation("read", userId, organizationId);
  return withImageReadCapacity(async () => {
    const client = await db.connect();
    try {
      await client.query("begin");
      const access = await client.query<StoredImage & { organizationId: string }>(
        `${sql} for share of ${kind === "asset" ? "a,m,u" : "t,f,m,u"}`,
        [id, userId, version, organizationId],
      );
      const value = access.rows.length === 1 ? await work(client, access.rows[0]!) : null;
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}
