import type { PoolClient } from "pg";
import { db } from "@/lib/db";
import { EDIT_ROLES_SQL } from "@/lib/organizations/roles";
import { OrganizationAccessError } from "@/lib/organizations/access-error";
export { OrganizationAccessError } from "@/lib/organizations/access-error";

/** Acquire quota admission before current authority; hold both through publication. */
export async function withOrganizationEditAuthority<T>(
  userId: string,
  organizationId: string,
  work: (client: PoolClient) => Promise<T>,
) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [organizationId]);
    const access = await client.query(
      `select 1 from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where m."organizationId"=$1 and m."userId"=$2 and m."role" in ${EDIT_ROLES_SQL} for share of m,u`,
      [organizationId, userId],
    );
    if (!access.rowCount)
      throw new OrganizationAccessError("Organization not found or access denied.");
    const value = await work(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
