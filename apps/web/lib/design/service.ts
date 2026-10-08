import { can, VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import { publishFileChanges } from "@/lib/realtime/server";
import { randomUUID } from "node:crypto";
import { discoverFileManagement, FileManagementError } from "./file-management-authority";
import { withOrganizationEditAuthority } from "./organization-authority";
import { db } from "@/lib/db";

export type DesignFrame = { id: string; x: number; y: number; width: number; height: number };
export type FrameInput = Omit<DesignFrame, "id">;
export type DesignRectangle = DesignFrame;
export type RectangleInput = FrameInput;

export function cleanDesignName(name: string) {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 120 && !/[\u0000-\u001f\u007f]/.test(trimmed)
    ? trimmed
    : null;
}

export function validDesignFrame(frame: FrameInput) {
  const values = [frame.x, frame.y, frame.width, frame.height];
  return (
    values.every(Number.isSafeInteger) &&
    frame.x >= 0 &&
    frame.y >= 0 &&
    frame.x <= 100000 &&
    frame.y <= 100000 &&
    frame.width >= 40 &&
    frame.height >= 40 &&
    frame.width <= 5000 &&
    frame.height <= 5000
  );
}

export function validDesignRectangle(rectangle: RectangleInput) {
  const values = [rectangle.x, rectangle.y, rectangle.width, rectangle.height];
  return (
    values.every(Number.isSafeInteger) &&
    rectangle.x >= 0 &&
    rectangle.y >= 0 &&
    rectangle.x <= 100000 &&
    rectangle.y <= 100000 &&
    rectangle.width >= 1 &&
    rectangle.height >= 1 &&
    rectangle.width <= 5000 &&
    rectangle.height <= 5000
  );
}

export async function listDesignOrganizations(userId: string) {
  const result = await db.query<{ id: string; name: string; role: string }>(
    `select o."id", o."name", m."role" from "organization" o
     join "member" m on m."organizationId" = o."id"
     join "user" u on u."id"=m."userId" and u."emailVerified"=true
     where m."userId" = $1 and m."role" in ${VIEW_ROLES_SQL} order by o."name"`,
    [userId],
  );
  return result.rows.map(({ role, ...organization }) => ({
    ...organization,
    canEdit: can(role, "edit"),
  }));
}

export async function listDesignFiles(userId: string, organizationId: string) {
  const result = await db.query<{
    id: string;
    name: string;
    folderId: string | null;
    updatedAt: Date;
    role: string;
  }>(
    `select f."id", f."name", f."folderId", f."updatedAt", m."role" from "designFile" f
     join "member" m on m."organizationId" = f."organizationId"
     join "user" u on u."id"=m."userId" and u."emailVerified"=true
     where f."organizationId" = $1 and m."userId" = $2 and m."role" in ${VIEW_ROLES_SQL} and f."archivedAt" is null
     order by f."updatedAt" desc, f."id"`,
    [organizationId, userId],
  );
  return result.rows;
}

export async function getDesignFile(
  userId: string,
  fileId: string,
  legacy = true,
  includeArchived = false,
) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await client.query<{
      id: string;
      name: string;
      organizationId: string;
      organizationName: string;
      folderId: string | null;
      updatedAt: Date;
      archivedAt: Date | null;
      role: string;
    }>(
      `select f."id", f."name", f."organizationId", o."name" as "organizationName",
       f."folderId", f."updatedAt", f."archivedAt", m."role" from "designFile" f
     join "organization" o on o."id" = f."organizationId"
     join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2
     join "user" u on u."id"=m."userId" and u."emailVerified"=true
     where f."id" = $1 and m."role" in ${VIEW_ROLES_SQL} and (f."archivedAt" is null or $3::boolean) for share of f,m,u`,
      [fileId, userId, includeArchived],
    );
    const file = result.rows[0];
    if (!file) {
      await client.query("commit");
      return null;
    }
    if (!legacy) {
      await client.query("commit");
      return { ...file, frames: [] as DesignFrame[], rectangles: [] as DesignRectangle[] };
    }
    const frames = await client.query<DesignFrame>(
      `select "id", "x", "y", "width", "height" from "designFrame"
     where "fileId" = $1 order by "createdAt", "id"`,
      [fileId],
    );
    const rectangles = await client.query<DesignRectangle>(
      `select "id", "x", "y", "width", "height" from "designRectangle"
     where "fileId" = $1 order by "createdAt", "id"`,
      [fileId],
    );
    await client.query("commit");
    return { ...file, frames: frames.rows, rectangles: rectangles.rows };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function createDesignFileForUser(
  userId: string,
  organizationId: string,
  name: string,
) {
  const cleanName = cleanDesignName(name);
  if (!cleanName) throw new FileManagementError("Enter a name of up to 120 characters.");
  const id = randomUUID();
  const bound = await discoverFileManagement(userId, organizationId, "organization");
  return withOrganizationEditAuthority(userId, bound, async (client) => {
    await client.query(
      `insert into "designFile" ("id", "organizationId", "name", "createdBy") values ($1,$2,$3,$4)`,
      [id, bound, cleanName, userId],
    );
    return { id, name: cleanName };
  });
}

export async function renameDesignFileForUser(userId: string, fileId: string, name: string) {
  const cleanName = cleanDesignName(name);
  if (!cleanName) throw new FileManagementError("Enter a name of up to 120 characters.");
  const bound = await discoverFileManagement(userId, fileId, "file");
  await withOrganizationEditAuthority(userId, bound, async (client) => {
    const result = await client.query(
      `update "designFile" set "name"=$2,"updatedAt"=now() where "id"=$1 and "organizationId"=$3 and "archivedAt" is null returning "id"`,
      [fileId, cleanName, bound],
    );
    if (result.rows.length !== 1) throw new FileManagementError("File not found or access denied.");
  });
  await publishFileChanges(fileId);
  return { id: fileId, name: cleanName };
}

/** Permanent deletion is available only after archiving, and only to editors. */
export async function deleteArchivedDesignFileForUser(userId: string, fileId: string) {
  const bound = await discoverFileManagement(userId, fileId, "file");
  await withOrganizationEditAuthority(userId, bound, async (client) => {
    const result = await client.query(
      `delete from "designFile" where "id"=$1 and "organizationId"=$2 and "archivedAt" is not null returning "id"`,
      [fileId, bound],
    );
    if (result.rows.length !== 1)
      throw new FileManagementError("Archived file not found or access denied.");
  });
}
