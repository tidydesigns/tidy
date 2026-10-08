import "server-only";
import { db } from "@/lib/db";
import { withoutDatabaseScope } from "@/lib/database-scope";
import { VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import {
  linearCredentialVersionSql,
  checkLinearAuthority,
  type LinearAuthority,
} from "./authority";
import { reserveLinearAttempts } from "./attempt-budget";
import { boundedLinearOperation } from "./work-budget";
import type { ConnectorConnection, ConnectorStatus } from "@/lib/connectors/catalog";
import {
  connectorPermission,
  connectorSchemaReady,
  requireConnectorSchema,
} from "@/lib/connectors/store";
import { ConnectorError } from "@/lib/connectors/http";
import { seal, unseal, type Sealed } from "@/lib/connectors/crypto";
import {
  exchangeToken,
  LinearError,
  linearIdentity,
  revokeToken,
  tokenScopes,
  type LinearToken,
} from "./client";
import { linearConfigured } from "./config";

export function credentialContext(userId: string, workspaceId: string) {
  return `linear:${userId}:${workspaceId}`;
}
export async function linearStatus(
  userId: string,
  organizationId: string,
): Promise<ConnectorStatus> {
  await connectorPermission(userId, organizationId);
  const ready = await connectorSchemaReady();
  if (!ready) return { ready, configured: linearConfigured(), connections: [], error: null };
  const connections = await db.query<ConnectorConnection>(
    `select c."id", a."id" as "accountId", a."provider", a."workspaceName", a."accountName", a."state"
    from "connectorConnection" c join "connectorAccount" a on a."id"=c."accountId"
    join "member" m on m."organizationId"=c."organizationId" and m."userId"=a."userId"
    join "user" u on u."id"=m."userId" and u."emailVerified"=true
    where c."organizationId"=$1 and a."userId"=$2 and a."provider"='linear' and m."role" in ${VIEW_ROLES_SQL} order by c."createdAt", c."id"`,
    [organizationId, userId],
  );
  return { ready, configured: linearConfigured(), connections: connections.rows, error: null };
}

type Account = {
  id: string;
  externalWorkspaceId: string;
  externalUserId: string;
  credentials: Sealed | null;
  expiresAt: Date;
  state: string;
  credentialVersion: string;
};
async function account(
  client: { query: typeof db.query },
  userId: string,
  organizationId: string,
  connectionId: string,
  lock = false,
) {
  const result = await client.query<Account>(
    `select a."id",a."externalWorkspaceId",a."externalUserId",a."credentials",a."expiresAt",a."state",${linearCredentialVersionSql} as "credentialVersion"
     from "connectorAccount" a join "connectorConnection" c on c."accountId"=a."id"
     join "user" u on u."id"=a."userId" and u."emailVerified"=true
     where c."id"=$1 and c."organizationId"=$2 and a."userId"=$3 and a."provider"='linear'
     ${lock ? "for update of a for share of c,u" : ""}`,
    [connectionId, organizationId, userId],
  );
  if (result.rows.length !== 1) throw new ConnectorError("Linear connection not found.", 404);
  const row = result.rows[0]!;
  if (row.state !== "connected" || !row.credentials) throw new LinearError(401);
  return row;
}
async function refreshAccount(userId: string, organizationId: string, connectionId: string) {
  return withoutDatabaseScope(async () => {
    const client = await db.connect();
    let committed = false;
    try {
      await client.query("begin");
      let row = await account(client, userId, organizationId, connectionId, true);
      if (row.expiresAt.getTime() < Date.now() + 60000) {
        const context = credentialContext(userId, row.externalWorkspaceId);
        const previous = JSON.parse(unseal(row.credentials!, context)) as LinearToken;
        let token: LinearToken;
        try {
          token = await exchangeToken({
            grant_type: "refresh_token",
            refresh_token: previous.refresh_token,
          });
        } catch (error) {
          if (error instanceof LinearError && error.status === 401) {
            await client.query(
              `update "connectorAccount" set "credentials"=null,"state"='reconnect',"updatedAt"=now() where "id"=$1`,
              [row.id],
            );
            await client.query("commit");
            committed = true;
          }
          throw error;
        }
        await client.query(
          `update "connectorAccount" set "credentials"=$2,"expiresAt"=$3,"scopes"=$4,"updatedAt"=now() where "id"=$1`,
          [
            row.id,
            seal(JSON.stringify(token), context),
            new Date(Date.now() + token.expires_in * 1000),
            tokenScopes(token),
          ],
        );
        row = await account(client, userId, organizationId, connectionId);
      }
      await client.query("commit");
      committed = true;
      return row;
    } catch (error) {
      if (!committed) await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}
/** Capture personal identity/version, then validate the provider and current local grant. */
export const linearAccess = boundedLinearOperation(async function linearAccess(
  userId: string,
  organizationId: string,
  connectionId: string,
  write: boolean = false,
) {
  await requireConnectorSchema();
  await connectorPermission(userId, organizationId, write ? "edit" : "view");
  await reserveLinearAttempts(write ? "write" : "read", userId, organizationId);
  let row = await account(db, userId, organizationId, connectionId);
  if (row.expiresAt.getTime() < Date.now() + 60000)
    row = await refreshAccount(userId, organizationId, connectionId);
  const token = JSON.parse(
    unseal(row.credentials!, credentialContext(userId, row.externalWorkspaceId)),
  ) as LinearToken;
  if (write && !tokenScopes(token).includes("write"))
    throw new ConnectorError("Reconnect Linear to allow issue updates.", 403);
  const access: LinearAuthority & { token: string } = {
    organizationId,
    connectionId,
    accountId: row.id,
    workspaceId: row.externalWorkspaceId,
    externalUserId: row.externalUserId,
    credentialVersion: row.credentialVersion,
    token: token.access_token,
  };
  const identity = await linearIdentity(access.token);
  if (
    identity.organization.id !== access.workspaceId ||
    identity.viewer.id !== access.externalUserId
  )
    throw new LinearError(401);
  await checkLinearAuthority(db, userId, access, write);
  return access;
});

export const disconnectLinear = boundedLinearOperation(async function disconnectLinear(
  userId: string,
  organizationId: string,
  connectionId: string,
) {
  await requireConnectorSchema();
  await connectorPermission(userId, organizationId);
  await reserveLinearAttempts("write", userId, organizationId);
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [organizationId]);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `linear-accounts:${userId}`,
    ]);
    const live = await client.query(
      `select 1 from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where m."organizationId"=$1 and m."userId"=$2 and m."role" in ${VIEW_ROLES_SQL} for share of m,u`,
      [organizationId, userId],
    );
    if (live.rows.length !== 1) throw new ConnectorError("Workspace access denied.", 403);
    const row = (
      await client.query<{ id: string; externalWorkspaceId: string; credentials: Sealed | null }>(
        `select a."id",a."externalWorkspaceId",a."credentials" from "connectorAccount" a
      join "connectorConnection" c on c."accountId"=a."id" where c."id"=$1 and c."organizationId"=$2 and a."userId"=$3 and a."provider"='linear' for update of a,c`,
        [connectionId, organizationId, userId],
      )
    ).rows[0];
    if (!row) throw new ConnectorError("Linear connection not found.", 404);
    const other = await client.query(
      `select 1 from "connectorConnection" where "accountId"=$1 and "id"<>$2`,
      [row.id, connectionId],
    );
    if (!other.rowCount && row.credentials) {
      const token = JSON.parse(
        unseal(row.credentials, credentialContext(userId, row.externalWorkspaceId)),
      ) as LinearToken;
      await revokeToken(token.refresh_token);
    }
    await client.query(`delete from "connectorConnection" where "id"=$1`, [connectionId]);
    await client.query(
      `delete from "connectorOAuthState" where "userId"=$1 and "organizationId"=$2 and "provider"='linear'`,
      [userId, organizationId],
    );
    if (!other.rowCount)
      await client.query(`delete from "connectorAccount" where "id"=$1`, [row.id]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
});
