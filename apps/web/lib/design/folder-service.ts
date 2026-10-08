import { randomUUID } from "node:crypto";
import {
  discoverFileManagement,
  folderAuthority,
  FileManagementError,
  validId,
} from "./file-management-authority";
import { FILE_MANAGEMENT_LIMITS } from "@/lib/security/resource-limits";
import { withOrganizationEditAuthority } from "./organization-authority";
import { db } from "@/lib/db";
import { can, VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import { publishFileChanges } from "@/lib/realtime/server";
import { cleanDesignName } from "./service";

type DesignFolder = {
  id: string;
  organizationId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
};

export async function listDesignFolders(userId: string, organizationId: string) {
  const result = await db.query<DesignFolder & { role: string }>(
    `select d."id", d."organizationId", d."name", d."createdAt", d."updatedAt", m."role"
     from "designFolder" d join "member" m on m."organizationId" = d."organizationId"
     join "user" u on u."id"=m."userId" and u."emailVerified"=true
     where d."organizationId" = $1 and m."userId" = $2 and m."role" in ${VIEW_ROLES_SQL} order by d."name", d."id"`,
    [organizationId, userId],
  );
  return result.rows.map(({ role, ...folder }) => ({ ...folder, canEdit: can(role, "edit") }));
}

export async function createDesignFolderForUser(
  userId: string,
  organizationId: string,
  name: string,
) {
  const cleanName = cleanDesignName(name);
  if (!cleanName) throw new FileManagementError("Enter a name of up to 120 characters.");
  const bound = await discoverFileManagement(userId, organizationId, "organization");
  return withOrganizationEditAuthority(userId, bound, async (client) => {
    const result = await client.query<DesignFolder>(
      `insert into "designFolder" ("id", "organizationId", "name", "createdBy") values ($1,$2,$3,$4)
      returning "id", "organizationId", "name", "createdAt", "updatedAt"`,
      [randomUUID(), bound, cleanName, userId],
    );
    return result.rows[0];
  });
}

export async function renameDesignFolderForUser(userId: string, folderId: string, name: string) {
  const cleanName = cleanDesignName(name);
  if (!cleanName) throw new FileManagementError("Enter a name of up to 120 characters.");
  const bound = await discoverFileManagement(userId, folderId, "folder");
  return withOrganizationEditAuthority(userId, bound, async (client) => {
    const result = await client.query<DesignFolder>(
      `update "designFolder" set "name"=$2,"updatedAt"=now() where "id"=$1 and "organizationId"=$3
       returning "id","organizationId","name","createdAt","updatedAt"`,
      [folderId, cleanName, bound],
    );
    if (result.rows.length !== 1)
      throw new FileManagementError("Folder not found or access denied.");
    return result.rows[0]!;
  });
}

export async function moveDesignFileForUser(
  userId: string,
  fileId: string,
  folderId: string | null,
) {
  if (folderId !== null && !validId(folderId))
    throw new FileManagementError("File or folder not found or access denied.");
  const bound = await discoverFileManagement(userId, fileId, "file");
  const value = await withOrganizationEditAuthority(userId, bound, async (client) => {
    if (folderId !== null) await folderAuthority(client, bound, folderId);
    const result = await client.query<{
      id: string;
      organizationId: string;
      name: string;
      folderId: string | null;
      updatedAt: Date;
    }>(
      `update "designFile" set "folderId"=$2,"updatedAt"=now() where "id"=$1 and "organizationId"=$3
       returning "id","organizationId","name","folderId","updatedAt"`,
      [fileId, folderId, bound],
    );
    if (result.rows.length !== 1)
      throw new FileManagementError("File or folder not found or access denied.");
    return result.rows[0]!;
  });
  await publishFileChanges(fileId);
  return value;
}

export async function deleteDesignFolderForUser(userId: string, folderId: string) {
  const bound = await discoverFileManagement(userId, folderId, "folder");
  const fileIds = await withOrganizationEditAuthority(userId, bound, async (client) => {
    // All folder mutations take the organization admission lock before product locks.
    const folder = await client.query(
      `select "id" from "designFolder" where "id"=$1 and "organizationId"=$2 for update`,
      [folderId, bound],
    );
    if (folder.rows.length !== 1)
      throw new FileManagementError("Folder not found or access denied.");
    const files = await client.query<{ id: string }>(
      `select "id" from "designFile" where "folderId"=$1 and "organizationId"=$2 order by "id" limit $3 for update`,
      [folderId, bound, FILE_MANAGEMENT_LIMITS.filesPerFolderRemoval + 1],
    );
    if (files.rows.length > FILE_MANAGEMENT_LIMITS.filesPerFolderRemoval)
      throw new FileManagementError(
        "This folder has too many files to remove at once. Move files out first.",
      );
    await client.query(
      `update "designFile" set "folderId"=null,"updatedAt"=now() where "folderId"=$1 and "organizationId"=$2`,
      [folderId, bound],
    );
    await client.query(`delete from "designFolder" where "id"=$1 and "organizationId"=$2`, [
      folderId,
      bound,
    ]);
    return files.rows.map(({ id }) => id);
  });
  // Durable metadata events already committed. Rooms recover even if immediate
  // notification fails; bound notification work and leave no database locks held.
  const deadline = Date.now() + 3000;
  for (let offset = 0; offset < fileIds.length && Date.now() < deadline; offset += 4)
    await Promise.all(fileIds.slice(offset, offset + 4).map(publishFileChanges));
  return { id: folderId, unfiledFileCount: fileIds.length };
}
