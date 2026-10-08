import { reserveLinearAttempts } from "./attempt-budget";
import { boundedLinearOperation } from "./work-budget";
import { LINEAR_LIMITS } from "@/lib/security/resource-limits";
import { VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  hash,
  pkceChallenge,
  randomToken,
  seal,
  unseal,
  type Sealed,
} from "@/lib/connectors/crypto";
import { connectorPermission, requireConnectorSchema } from "@/lib/connectors/store";
import { ConnectorError } from "@/lib/connectors/http";
import { linearConfig, linearConfigured } from "./config";
import { credentialContext } from "./connections";
import { exchangeToken, linearIdentity, tokenScopes } from "./client";
import {
  requireOAuthSession,
  oauthVerifier,
  readOAuthVerifier,
} from "@/lib/connectors/oauth-session";

export async function beginLinearAuthorization(
  userId: string,
  organizationId: string,
  sessionId: string,
  accountId?: string,
) {
  await requireConnectorSchema();
  if (typeof organizationId !== "string" || !organizationId || organizationId.length > 200)
    throw new ConnectorError("Choose an organisation.");
  await connectorPermission(userId, organizationId);
  await requireOAuthSession(db, userId, sessionId);
  if (!linearConfigured()) throw new ConnectorError("Linear is not available yet.", 503);
  if (
    accountId &&
    !(
      await db.query(
        `select 1 from "connectorAccount" a join "connectorConnection" c on c."accountId"=a."id"
    where a."id"=$1 and a."userId"=$2 and c."organizationId"=$3 and a."provider"='linear'`,
        [accountId, userId, organizationId],
      )
    ).rowCount
  )
    throw new ConnectorError("Linear connection not found.", 404);
  await reserveLinearAttempts("oauth", userId, organizationId);
  const state = randomToken(),
    verifier = randomToken();
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [organizationId]);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `linear-states:${userId}`,
    ]);
    await requireOAuthSession(client, userId, sessionId, true);
    const live = await client.query(
      `select 1 from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
      where m."userId"=$1 and m."organizationId"=$2 and m."role" in ${VIEW_ROLES_SQL} for share of m,u`,
      [userId, organizationId],
    );
    if (live.rows.length !== 1) throw new ConnectorError("Workspace access denied.", 403);
    if (
      accountId &&
      !(
        await client.query(
          `select 1 from "connectorAccount" a join "connectorConnection" c on c."accountId"=a."id"
       where a."id"=$1 and a."userId"=$2 and c."organizationId"=$3 and a."provider"='linear' for share of a,c`,
          [accountId, userId, organizationId],
        )
      ).rowCount
    )
      throw new ConnectorError("Linear connection not found.", 404);
    const capacity = await client.query<{ total: number; workspace: number }>(
      `select count(*)::int as total,
      count(*) filter(where "organizationId"=$2)::int as workspace from "connectorOAuthState" where "userId"=$1 and "expiresAt">now()`,
      [userId, organizationId],
    );
    if (
      capacity.rows[0]!.total >= LINEAR_LIMITS.statesPerUser ||
      capacity.rows[0]!.workspace >= LINEAR_LIMITS.statesPerUserOrganization
    )
      throw new ConnectorError(
        "Too many pending Linear sign-ins. Finish a sign-in or wait before trying again.",
        429,
      );
    // Bound opportunistic cleanup to this actor; operator cleanup handles historical rows.
    await client.query(
      `delete from "connectorOAuthState" where "hash" in (select "hash" from "connectorOAuthState" where "userId"=$1 and "expiresAt"<now() order by "expiresAt" limit 1000)`,
      [userId],
    );
    await client.query(
      `insert into "connectorOAuthState" ("hash","provider","userId","organizationId","accountId","verifier","expiresAt")
    values ($1,'linear',$2,$3,$4,$5,now()+interval '10 minutes')`,
      [
        hash(state),
        userId,
        organizationId,
        accountId ?? null,
        seal(oauthVerifier(verifier, sessionId), `linear:oauth:${userId}:${hash(state)}`),
      ],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const config = linearConfig();
  const url = new URL("https://linear.app/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${config.origin}/api/linear/callback`,
    response_type: "code",
    scope: "read,write",
    actor: "user",
    prompt: "consent",
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return { state, url: url.href };
}

export const completeLinearAuthorization = boundedLinearOperation(
  async function completeLinearAuthorization(
    userId: string,
    state: string | null,
    cookieState: string | undefined,
    code: string | null,
    sessionId: string,
  ) {
    await requireConnectorSchema();
    if (!state || state.length > 128 || state !== cookieState || !code || code.length > 4096)
      throw new ConnectorError("Authorization could not be verified.");
    await requireOAuthSession(db, userId, sessionId);
    // Keep claimed authority removable by disconnect until publication commits.
    const row = (
      await db.query<{ organizationId: string; accountId: string | null; verifier: Sealed }>(
        `update "connectorOAuthState" set "verifier"="verifier" || '{"claimed":true}'::jsonb
    where "hash"=$1 and "userId"=$2 and "provider"='linear' and "expiresAt">now() and not ("verifier" ? 'claimed')
    returning "organizationId","accountId","verifier"`,
        [hash(state), userId],
      )
    ).rows[0];
    if (!row) throw new ConnectorError("Authorization expired. Connect Linear again.");
    try {
      const verifier = readOAuthVerifier(
        unseal(row.verifier, `linear:oauth:${userId}:${hash(state)}`),
        sessionId,
      );
      await connectorPermission(userId, row.organizationId);
      const token = await exchangeToken({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: `${linearConfig().origin}/api/linear/callback`,
      });
      const identity = await linearIdentity(token.access_token);
      const client = await db.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          row.organizationId,
        ]);
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `linear-accounts:${userId}`,
        ]);
        await requireOAuthSession(client, userId, sessionId, true);
        const member = await client.query(
          `select 1 from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true where m."userId"=$1 and m."organizationId"=$2 and m."role" in ${VIEW_ROLES_SQL} for share of m,u`,
          [userId, row.organizationId],
        );
        if (!member.rowCount) throw new ConnectorError("Workspace access denied.", 403);
        const stateRecord = await client.query(
          `delete from "connectorOAuthState" where "hash"=$1 and "userId"=$2 and "organizationId"=$3 and "provider"='linear'
         and "expiresAt">clock_timestamp() and "verifier" ? 'claimed' returning "hash"`,
          [hash(state), userId, row.organizationId],
        );
        if (stateRecord.rows.length !== 1)
          throw new ConnectorError("Authorization expired. Connect Linear again.", 403);
        const existing = (
          await client.query<{ id: string; externalUserId: string }>(
            `select "id","externalUserId" from "connectorAccount"
      where "userId"=$1 and "provider"='linear' and "externalWorkspaceId"=$2 for update`,
            [userId, identity.organization.id],
          )
        ).rows[0];
        if (
          (row.accountId && row.accountId !== existing?.id) ||
          (existing && existing.externalUserId !== identity.viewer.id)
        )
          throw new ConnectorError(
            "Choose the same Linear account and workspace when reconnecting.",
          );
        if (!existing) {
          const count = await client.query<{ count: number }>(
            `select count(*)::int as count from "connectorAccount" where "userId"=$1 and "provider"='linear'`,
            [userId],
          );
          if (count.rows[0]!.count >= LINEAR_LIMITS.accountsPerUser)
            throw new ConnectorError("Too many Linear accounts. Disconnect an account first.", 409);
        }
        const linked =
          existing &&
          (
            await client.query(
              `select 1 from "connectorConnection" where "organizationId"=$1 and "accountId"=$2`,
              [row.organizationId, existing.id],
            )
          ).rows.length === 1;
        if (!linked) {
          const count = await client.query<{ count: number }>(
            `select count(*)::int as count from "connectorConnection" where "organizationId"=$1`,
            [row.organizationId],
          );
          if (count.rows[0]!.count >= LINEAR_LIMITS.connectionsPerOrganization)
            throw new ConnectorError(
              "This workspace has too many connector links. Disconnect a link first.",
              409,
            );
        }
        const accountId = existing?.id ?? randomUUID();
        await client.query(
          `insert into "connectorAccount" ("id","provider","userId","externalWorkspaceId","externalUserId","workspaceName","accountName","credentials","scopes","expiresAt")
      values ($1,'linear',$2,$3,$4,$5,$6,$7,$8,$9) on conflict ("id") do update set "workspaceName"=excluded."workspaceName","accountName"=excluded."accountName",
      "credentials"=excluded."credentials","scopes"=excluded."scopes","expiresAt"=excluded."expiresAt","state"='connected',"updatedAt"=now()`,
          [
            accountId,
            userId,
            identity.organization.id,
            identity.viewer.id,
            identity.organization.name,
            identity.viewer.name,
            seal(JSON.stringify(token), credentialContext(userId, identity.organization.id)),
            tokenScopes(token),
            new Date(Date.now() + token.expires_in * 1000),
          ],
        );
        await client.query(
          `insert into "connectorConnection" ("id","accountId","organizationId") values ($1,$2,$3) on conflict ("organizationId","accountId") do nothing`,
          [randomUUID(), accountId, row.organizationId],
        );
        await client.query("commit");
        return { organizationId: row.organizationId };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    } finally {
      await db
        .query(
          'delete from "connectorOAuthState" where "hash"=$1 and "userId"=$2 and "provider"=\'linear\'',
          [hash(state), userId],
        )
        .catch(() => {});
    }
  },
);
