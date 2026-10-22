import "server-only";
import { discoverFileManagement } from "@/lib/design/file-management-authority";
import { withOrganizationEditAuthority } from "@/lib/design/organization-authority";
import { publishFileChanges } from "@/lib/realtime/server";

export class DesktopNameConflict extends Error {}
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
      throw new Error("This cloud file ID is already in use.");
    // Check before INSERT so an acknowledged creation remains retryable at the file quota.
    if (!row)
      await client.query(
        'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,$3,$4)',
        [id, organizationId, name, userId],
      );
    return { id };
  });
}
