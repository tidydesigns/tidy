import "server-only";
import type { PoolClient } from "pg";
import { db } from "@/lib/db";
import { EDIT_ROLES_SQL, VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import { ConnectorError } from "@/lib/connectors/error";

export const linearCredentialVersionSql = `encode(sha256(convert_to(a."credentials"::text,'UTF8')),'hex')`;
export type LinearAuthority = {
  organizationId: string;
  connectionId: string;
  accountId: string;
  workspaceId: string;
  externalUserId: string;
  credentialVersion: string;
};
export async function checkLinearAuthority(
  client: Pick<PoolClient, "query">,
  userId: string,
  access: LinearAuthority,
  write: boolean,
  lock = false,
) {
  const result = await client.query(
    `select 1 from "connectorConnection" c join "connectorAccount" a on a."id"=c."accountId"
     join "member" m on m."organizationId"=c."organizationId" and m."userId"=a."userId"
     join "user" u on u."id"=m."userId" and u."emailVerified"=true
     where c."id"=$1 and c."organizationId"=$2 and a."userId"=$3 and a."id"=$4 and a."provider"='linear'
     and a."state"='connected' and a."externalWorkspaceId"=$5 and a."externalUserId"=$6
     and ${linearCredentialVersionSql}=$7 and m."role" in ${write ? EDIT_ROLES_SQL : VIEW_ROLES_SQL}
     ${lock ? "for share of c,a,m,u" : ""}`,
    [
      access.connectionId,
      access.organizationId,
      userId,
      access.accountId,
      access.workspaceId,
      access.externalUserId,
      access.credentialVersion,
    ],
  );
  if (result.rows.length !== 1)
    throw new ConnectorError("Linear connection or workspace access changed. Try again.", 403);
}
/** Retain current local authority during publication; discovery is completed first. */
export async function withLinearAuthority<T>(
  userId: string,
  access: LinearAuthority,
  write: boolean,
  work: (client: PoolClient) => Promise<T>,
) {
  const client = await db.connect();
  try {
    await client.query("begin");
    if (write)
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        access.organizationId,
      ]);
    await checkLinearAuthority(client, userId, access, write, true);
    const value = await work(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
