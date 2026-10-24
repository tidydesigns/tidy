import "server-only";
import { discoverFileManagement } from "@/lib/design/file-management-authority";
import { withOrganizationEditAuthority } from "@/lib/design/organization-authority";
import { publishFileChanges } from "@/lib/realtime/server";
import { db } from "@/lib/db";
import { EDIT_ROLES_SQL, VIEW_ROLES_SQL } from "@/lib/organizations/roles";

/** Keep the native catalog metadata-only; image bytes are requested separately. */
export async function listDesktopFiles(userId: string, organizationId: string) {
  const result = await db.query<{
    id: string;
    name: string;
    folderId: string | null;
    updatedAt: Date;
    createdAt: Date;
    creatorId: string;
    creatorName: string;
    creatorImage: string | null;
  }>(
    `select f."id", f."name", f."folderId", f."updatedAt", f."createdAt",
      creator."id" as "creatorId", creator."name" as "creatorName", creator."image" as "creatorImage"
     from "designFile" f
     join "member" m on m."organizationId"=f."organizationId" and m."userId"=$1 and m."role" in ${VIEW_ROLES_SQL}
     join "user" viewer on viewer."id"=m."userId" and viewer."emailVerified"=true
     join "user" creator on creator."id"=f."createdBy"
     where f."organizationId"=$2 and f."archivedAt" is null
     order by f."updatedAt" desc, f."id"`,
    [userId, organizationId],
  );
  return result.rows;
}

/** Metadata only: one bounded query for all downloaded designs, with live access locks. */
export async function desktopManifest(userId: string, fileIds: string[]) {
  const result = await db.query<{
    fileId: string;
    revision: number;
    name: string;
    canEdit: boolean;
  }>(
    `select f."id" as "fileId", coalesce(d."revision", 0) as revision, f."name",
      m."role" in ${EDIT_ROLES_SQL} as "canEdit"
     from "designFile" f
     join "member" m on m."organizationId"=f."organizationId" and m."userId"=$2 and m."role" in ${VIEW_ROLES_SQL}
     join "user" u on u."id"=m."userId" and u."emailVerified"=true
     left join "designDocument" d on d."fileId"=f."id"
     where f."id"=any($1::text[]) and f."archivedAt" is null
     order by f."id" for share of f,m,u`,
    [fileIds, userId],
  );
  return result.rows;
}

export class DesktopNameConflict extends Error {}
export class DesktopFileConflict extends Error {}
export async function renameDesktopFile(
  userId: string,
  fileId: string,
  before: string,
  name: string,
) {
  const organizationId = await discoverFileManagement(userId, fileId, "file");
  await withOrganizationEditAuthority(userId, organizationId, async (client) => {
    const result = await client.query(
      'update "designFile" set "name"=$2,"updatedAt"=now() where "id"=$1 and "organizationId"=$3 and "archivedAt" is null and ("name"=$4 or "name"=$2) returning "id"',
      [fileId, name, organizationId, before],
    );
    if (!result.rowCount) throw new DesktopNameConflict("The file was renamed elsewhere.");
  });
  await publishFileChanges(fileId);
  return { name };
}

/** The native client persists this UUID before creating a file, so lost responses
 * and offline restarts can retry without creating duplicate designs. */
export async function createDesktopFile(
  userId: string,
  organizationId: string,
  id: string,
  name: string,
) {
  await discoverFileManagement(userId, organizationId, "organization");
  return withOrganizationEditAuthority(userId, organizationId, async (client) => {
    const existing = await client.query<{
      organizationId: string;
      createdBy: string;
      archivedAt: Date | null;
    }>('select "organizationId","createdBy","archivedAt" from "designFile" where "id"=$1', [id]);
    const row = existing.rows[0];
    if (
      row &&
      (row.organizationId !== organizationId || row.createdBy !== userId || row.archivedAt)
    )
      throw new DesktopFileConflict("This cloud file ID is already in use.");
    // Check before INSERT so an acknowledged creation remains retryable at the file quota.
    if (!row)
      await client.query(
        'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,$3,$4)',
        [id, organizationId, name, userId],
      );
    return { id };
  });
}
