import { PublicActionError } from "@/lib/security/public-error";
import "server-only";
import type { PoolClient } from "pg";
import { db } from "@/lib/db";
import { EDIT_ROLES_SQL } from "@/lib/organizations/roles";
import { reserveFileManagement } from "./file-management-budget";

export class FileManagementError extends PublicActionError {}
export const validId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= 120;
const missing = () => new FileManagementError("File or folder not found or access denied.");
/** Cheap discovery retains no locks. The stored parent is bound again after admission. */
export async function discoverFileManagement(
  userId: string,
  selector: string,
  kind: "organization" | "file" | "folder",
) {
  if (!validId(selector)) throw missing();
  const result = await db.query<{ organizationId: string }>(
    kind === "organization"
      ? `select m."organizationId" from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
         where m."organizationId"=$1 and m."userId"=$2 and m."role" in ${EDIT_ROLES_SQL}`
      : `select p."organizationId" from "${kind === "file" ? "designFile" : "designFolder"}" p
         join "member" m on m."organizationId"=p."organizationId" and m."userId"=$2 and m."role" in ${EDIT_ROLES_SQL}
         join "user" u on u."id"=m."userId" and u."emailVerified"=true where p."id"=$1`,
    [selector, userId],
  );
  if (result.rows.length !== 1) throw missing();
  const organizationId = result.rows[0]!.organizationId;
  await reserveFileManagement(userId, organizationId);
  return organizationId;
}

export async function folderAuthority(
  client: PoolClient,
  organizationId: string,
  folderId: string,
) {
  const result = await client.query<{ name: string }>(
    `select "name" from "designFolder" where "id"=$1 and "organizationId"=$2 for share`,
    [folderId, organizationId],
  );
  if (result.rows.length !== 1) throw missing();
  return result.rows[0]!;
}
