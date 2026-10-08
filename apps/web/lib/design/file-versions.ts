import "server-only";
import { fileVersion } from "./file-version";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { EDIT_ROLES_SQL, VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import type { DesignDocument } from "./document";
import { withPrivateImageAccess } from "./image-authority";
import { imageFailureResponse } from "./image-budget";
import { IMAGE_READ_LIMITS } from "@/lib/security/resource-limits";
import { designImageResponse } from "@/lib/storage/design-objects";

export type FileVersion = {
  id: string;
  sequence: string;
  revision: number;
  name: string | null;
  kind: "automatic" | "named" | "beforeRestore";
  createdAt: string;
  createdBy: string | null;
  author: string | null;
};
export type VersionPreview = {
  version: FileVersion;
  content: DesignDocument;
  currentRevision: number;
};
export class VersionError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function versionSchemaReady() {
  return (
    (
      await db.query<{ ready: boolean }>(
        `select to_regclass('"designFileVersion"') is not null and to_regclass('"designFileRestore"') is not null as ready`,
      )
    ).rows[0]?.ready === true
  );
}
const metadata = `v."id",v."sequence"::text,v."revision",v."name",v."kind",
  v."createdAt",v."createdBy",coalesce(v."createdByName",u."name") as "author"`;
const authorized = `join "designFile" f on f."id"=v."fileId"
  join "member" m on m."organizationId"=f."organizationId" and m."userId"=$2 and m."role" in ${VIEW_ROLES_SQL}
  left join "user" u on u."id"=v."createdBy"`;
export async function listFileVersions(userId: string, fileId: string, before?: string) {
  const access = await db.query(
    `select 1 from "designFile" f join "member" m on m."organizationId"=f."organizationId" and m."userId"=$2 and m."role" in ${VIEW_ROLES_SQL} where f."id"=$1`,
    [fileId, userId],
  );
  if (!access.rowCount) throw new VersionError("File not found or access denied.", 404);
  const rows = (
    await db.query<FileVersion>(
      `select ${metadata} from "designFileVersion" v ${authorized}
    where v."fileId"=$1 and ($3::bigint is null or v."sequence"<$3) order by v."sequence" desc limit 21`,
      [fileId, userId, before ?? null],
    )
  ).rows;
  return { versions: rows.slice(0, 20), nextCursor: rows.length > 20 ? rows[19].sequence : null };
}
export async function readFileVersion(
  userId: string,
  fileId: string,
  id: string,
): Promise<VersionPreview> {
  const row = (
    await db.query<FileVersion & { content: DesignDocument; currentRevision: number }>(
      `select ${metadata},v."content",d."revision" as "currentRevision" from "designFileVersion" v ${authorized}
    join "designDocument" d on d."fileId"=f."id" where v."fileId"=$1 and v."id"=$3`,
      [fileId, userId, id],
    )
  ).rows[0];
  if (!row) throw new VersionError("Version not found or access denied.", 404);
  const { content, currentRevision, ...version } = row;
  return { version, content, currentRevision };
}
export async function createFileVersion(
  userId: string,
  fileId: string,
  name: string,
  expectedRevision: number,
  id: string = randomUUID(),
) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const row = (
      await client.query<{ revision: number; content: DesignDocument }>(
        `select d."revision",d."content" from "designFile" f join "designDocument" d on d."fileId"=f."id"
      join "member" m on m."organizationId"=f."organizationId" and m."userId"=$2 and m."role" in ${EDIT_ROLES_SQL}
      where f."id"=$1 and f."archivedAt" is null for update of f,d`,
        [fileId, userId],
      )
    ).rows[0];
    if (!row) throw new VersionError("Editor access is required to create a version.", 403);
    const prior = (
      await client.query<{ fileId: string; createdBy: string; name: string; revision: number }>(
        'select "fileId","createdBy","name","revision" from "designFileVersion" where "id"=$1',
        [id],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.fileId !== fileId ||
        prior.createdBy !== userId ||
        prior.name !== name ||
        prior.revision !== expectedRevision
      )
        throw new VersionError("Version ID was already used for a different checkpoint.", 409);
    } else {
      if (row.revision !== expectedRevision)
        throw new VersionError(
          "The file changed. Review the current file before creating a version.",
          409,
        );
      await client.query(
        'insert into "designFileVersion" ("id","fileId","revision","content","name","kind","createdBy","createdByName") values ($1,$2,$3,$4::jsonb,$5,\'named\',$6,(select "name" from "user" where "id"=$6))',
        [id, fileId, row.revision, JSON.stringify(row.content), name, userId],
      );
    }
    await client.query("commit");
    return id;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
export async function fileVersionAsset(
  userId: string,
  fileId: string,
  versionId: string,
  assetId: string,
  request: Request,
) {
  try {
    return (
      (await withPrivateImageAccess(userId, assetId, "asset", null, async (client, asset) => {
        const reference = await client.query(
          `select 1 from "designFileVersionAsset" va join "designFileVersion" v on v."id"=va."versionId"
         join "designFile" f on f."id"=v."fileId"
         where va."assetId"=$1 and v."fileId"=$2 and v."id"=$3 and f."organizationId"=$4
         for share of va,v,f`,
          [assetId, fileId, versionId, asset.organizationId],
        );
        if (!reference.rowCount) throw new VersionError("Asset not found or access denied.", 404);
        return designImageResponse(
          asset,
          async () =>
            (
              await client.query<{ body: Buffer | null }>(
                `select "body" from "designAsset" where "id"=$1 and octet_length("body")<=$2`,
                [assetId, IMAGE_READ_LIMITS.bytes],
              )
            ).rows[0]?.body ?? null,
          request,
        );
      })) ?? new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } })
    );
  } catch (error) {
    if (error instanceof VersionError) throw error;
    return imageFailureResponse(error);
  }
}

export async function fileVersionsForUser(userId: string, ids: string[]) {
  if (ids.length > 100 || ids.some((id) => typeof id !== "string" || !id || id.length > 120))
    throw new Error("Choose up to 100 files.");
  const result = await db.query<{
    id: string;
    updatedAt: Date;
    revision: number | null;
    thumbnailVersion: string | null;
  }>(
    `select f."id", f."updatedAt", d."revision", t."version" as "thumbnailVersion" from "designFile" f
     join "member" m on m."organizationId" = f."organizationId" and m."userId" = $1 and m."role" in ${VIEW_ROLES_SQL}
     join "user" identity on identity."id"=m."userId" and identity."emailVerified"=true
     left join "designDocument" d on d."fileId"=f."id"
     left join "designFileThumbnail" t on t."fileId"=f."id"
     where f."id" = any($2::text[])`,
    [userId, ids],
  );
  return {
    versions: Object.fromEntries(
      result.rows.map((file) => [file.id, fileVersion(file.updatedAt, file.revision)]),
    ),
    thumbnailVersions: Object.fromEntries(
      result.rows.map((file) => [file.id, file.thumbnailVersion ?? null]),
    ),
  };
}
