import "server-only";
import { db } from "@/lib/db";
import { documentSchemaReady } from "./document-service";
import { VIEW_ROLES_SQL } from "@/lib/organizations/roles";

type DesignFile = {
  id: string;
  name: string;
  folderId: string | null;
  updatedAt: Date;
  createdAt: Date;
  creatorName: string;
  creatorImage: string | null;
  frameCount: number;
  rectangleCount: number;
  nodeCount: number | null;
  documentRevision: number | null;
  thumbnailVersion: string | null;
};
type DesignFolder = {
  id: string;
  name: string;
  updatedAt: Date;
  createdAt: Date;
  creatorName: string;
  creatorImage: string | null;
};

export async function listBrowserFolders(userId: string, organizationId: string) {
  const result = await db.query<DesignFolder>(
    `select d."id", d."name", d."updatedAt", d."createdAt", u."name" as "creatorName", u."image" as "creatorImage" from "designFolder" d
     join "member" m on m."organizationId" = d."organizationId" and m."userId" = $1 and m."role" in ${VIEW_ROLES_SQL}
     join "user" identity on identity."id"=m."userId" and identity."emailVerified"=true
     join "user" u on u."id" = d."createdBy"
     where d."organizationId" = $2 order by d."name", d."id"`,
    [userId, organizationId],
  );
  return result.rows;
}

export async function listBrowserFiles(
  userId: string,
  organizationId: string,
  archived: boolean,
  folderId: string | null,
) {
  const hasDocumentSchema = await documentSchemaReady();
  const nodeCountSql = hasDocumentSchema
    ? `(select jsonb_array_length(d."content"->'nodes') from "designDocument" d where d."fileId" = f."id")`
    : `null::int`;
  const revisionSql = hasDocumentSchema
    ? `(select d."revision" from "designDocument" d where d."fileId"=f."id")`
    : `null::int`;
  const result = await db.query<DesignFile>(
    `select f."id", f."name", f."folderId", f."updatedAt", f."createdAt", u."name" as "creatorName", u."image" as "creatorImage",
       (select count(*)::int from "designFrame" fr where fr."fileId" = f."id") as "frameCount",
       (select count(*)::int from "designRectangle" r where r."fileId" = f."id") as "rectangleCount",
       ${nodeCountSql} as "nodeCount", ${revisionSql} as "documentRevision",
       (select t."version" from "designFileThumbnail" t where t."fileId"=f."id") as "thumbnailVersion"
     from "designFile" f
     join "member" m on m."organizationId" = f."organizationId" and m."userId" = $1 and m."role" in ${VIEW_ROLES_SQL}
     join "user" identity on identity."id"=m."userId" and identity."emailVerified"=true
     join "user" u on u."id" = f."createdBy"
     where f."organizationId" = $2
       and (case when $3::boolean then f."archivedAt" is not null
         else f."archivedAt" is null and ($4::text is null or f."folderId" = $4) end)
     order by f."updatedAt" desc`,
    [userId, organizationId, archived, folderId],
  );
  return result.rows;
}
