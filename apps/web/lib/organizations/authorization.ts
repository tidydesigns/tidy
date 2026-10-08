import "server-only";
import { db } from "@/lib/db";
import type { PoolClient } from "pg";
import { can, type Permission } from "./roles";
import { OrganizationAccessError } from "./access-error";
export { OrganizationAccessError } from "./access-error";

export async function requireOrganizationPermission(
  userId: string,
  organizationId: string,
  permission: Permission,
  client: Pick<PoolClient, "query"> = db,
) {
  const result = await client.query<{ role: string }>(
    'select m."role" from "member" m join "user" u on u."id" = m."userId" and u."emailVerified" = true where m."userId" = $1 and m."organizationId" = $2',
    [userId, organizationId],
  );
  if (!can(result.rows[0]?.role, permission))
    throw new OrganizationAccessError("Workspace access denied.");
  return result.rows[0].role;
}
export async function requireFilePermission(
  userId: string,
  fileId: string,
  permission: Permission,
) {
  const result = await db.query<{ role: string }>(
    `select m."role" from "member" m join "designFile" f on f."organizationId" = m."organizationId"
    join "user" u on u."id" = m."userId" and u."emailVerified" = true
    where m."userId" = $1 and f."id" = $2 and f."archivedAt" is null`,
    [userId, fileId],
  );
  if (!can(result.rows[0]?.role, permission))
    throw new OrganizationAccessError("File access denied.");
  return result.rows[0].role;
}
