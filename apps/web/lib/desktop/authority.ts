import "server-only";
import { db } from "@/lib/db";
import { inDatabaseScope } from "@/lib/database-scope";
import { requireMcpGrant, recheckRetainedMcpGrant } from "@/lib/mcp/authorizations";
import type { McpGrant } from "@/lib/mcp/grant-context";
import { VIEW_ROLES_SQL } from "@/lib/organizations/roles";

/** Reuse the OAuth grant/revocation contract, including its workspace → account lock order. */
export async function withDesktopAuthority<T>(
  grant: McpGrant,
  organizationId: string | undefined,
  write: boolean,
  work: () => Promise<T>,
  fileId?: string,
) {
  // Fetch reads without holding a database connection across R2 I/O, then
  // revalidate grant and membership at publication. Writes use the outer transaction.
  const read = write ? undefined : await work();
  const client = await db.connect();
  let afterCommit: (() => Promise<void>) | undefined;
  try {
    await client.query("begin");
    if (write && organizationId)
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [organizationId]);
    await requireMcpGrant(client, grant, grant.claims.sub as string);
    if (organizationId) {
      const membership = await client.query(
        `select 1 from "member" where "organizationId"=$1 and "userId"=$2
         and "role" in ${VIEW_ROLES_SQL} for share`,
        [organizationId, grant.claims.sub],
      );
      if (!membership.rowCount) throw new Error("Workspace access ended.");
      if (
        fileId &&
        !(
          await client.query(
            'select 1 from "designFile" where "id"=$1 and "organizationId"=$2 and "archivedAt" is null for share',
            [fileId, organizationId],
          )
        ).rowCount
      )
        throw new Error("File access ended.");
    }
    const result = await inDatabaseScope(client, write ? work : async () => read as T);
    await recheckRetainedMcpGrant(client, grant);
    await client.query("commit");
    afterCommit = result.afterCommit;
    return result.value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await afterCommit?.();
  }
}
