import { reservePersonalAttempts } from "@/lib/security/personal-budget";
import { requireVerifiedUser } from "@/lib/security/user-authority";
import { PublicActionError } from "@/lib/security/public-error";
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { PoolClient } from "pg";
import type { McpGrant } from "./grant-context";

function versionId(userId: string, clientId: string) {
  // Stable account/client lookup key; the digest contains no password material.
  return `mcp-grant:${createHash("sha256")
    .update(JSON.stringify([userId, clientId]))
    .digest("hex")}`;
}

export async function authorizationVersion(
  userId: string,
  clientId: string,
  client: Pick<PoolClient, "query"> = db,
) {
  const row = (
    await client.query<{ value: string }>('select "value" from "verification" where "id" = $1', [
      versionId(userId, clientId),
    ])
  ).rows[0];
  return row?.value ?? "0";
}

// requireMcpAuth verifies the signature, issuer, audience and scopes before this check.
// Grant versions also reject old JWTs after the same client is authorized again.
export async function hasMcpAuthorization(
  claims: Record<string, unknown>,
  resource: string,
  scopes: readonly string[] = ["mcp:read"],
) {
  return liveMcpGrant(db, { claims, resource, scopes });
}

export class McpGrantError extends PublicActionError {
  constructor() {
    super("Agent authorization has ended. Authorize again to reconnect.");
  }
}

async function liveMcpGrant(
  client: Pick<PoolClient, "query">,
  { claims, resource, scopes }: McpGrant,
  lock = false,
) {
  for (const key of ["sub", "client_id", "sid"])
    if (typeof claims[key] !== "string" || !claims[key] || (claims[key] as string).length > 2048)
      return false;
  // Require a finite expiry at every boundary, including protocol discovery.
  // Repeat after queued admission and before publication.
  const tokenLive = () =>
    typeof claims.exp === "number" && Number.isFinite(claims.exp) && claims.exp > Date.now() / 1000;
  if (!tokenLive()) return false;
  if (claims.bella_grant_version != null && typeof claims.bella_grant_version !== "string")
    return false;
  const userId = claims.sub as string,
    clientId = claims.client_id as string;
  if (lock)
    await client.query("select pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
      `mcp-consent:${userId}`,
    ]);
  // MATERIALIZED dependencies retain the existing user → client → resource →
  // link → session → consent lock order, in one database round trip. A plain
  // join with FOR SHARE lets the planner reorder locks and can deadlock with
  // account deletion. Never cache this result across requests or transactions.
  const held = lock ? " for share" : "";
  const result = await client.query(
    `with
    grant_user as materialized (
      select 1 from "user" where "id"=$1 and "emailVerified"=true${held}
    ), grant_client as materialized (
      select 1 from "oauthClient" where "clientId"=$2 and "disabled" is not true
      and ("scopes" is null or "scopes" ?& $4::text[])
      and exists(select 1 from grant_user)${held}
    ), grant_resource as materialized (
      select 1 from "oauthResource" where "identifier"=$3 and "disabled" is not true
      and ("allowedScopes" is null or "allowedScopes" ?& $4::text[])
      and exists(select 1 from grant_client)${held}
    ), grant_link as materialized (
      select 1 from "oauthClientResource" where "clientId"=$2 and "resourceId"=$3
      and exists(select 1 from grant_resource)${held}
    ), grant_session as materialized (
      select "expiresAt" from "session" where "id"=$5 and "userId"=$1 and "expiresAt">clock_timestamp()
      and exists(select 1 from grant_link)${held}
    ), grant_consent as materialized (
      select 1 from "oauthConsent" where "userId"=$1 and "clientId"=$2
      and "resources" @> jsonb_build_array($3::text) and "scopes" ?& $4::text[]
      and exists(select 1 from grant_session)${held}
    )
    select (select "expiresAt" from grant_session)>clock_timestamp() as live from grant_consent
    where coalesce((select "value" from "verification" where "id"=$6),'0')=$7`,
    [
      userId,
      clientId,
      resource,
      scopes,
      claims.sid,
      versionId(userId, clientId),
      claims.bella_grant_version ?? "0",
    ],
  );
  // The volatile clock expression is in the final projection, after the
  // materialized consent row (and therefore every preceding lock) is obtained.
  // A WHERE predicate could be pushed earlier and miss expiry during a wait.
  if (!result.rowCount || result.rows.some((row) => row.live !== true)) return false;
  return tokenLive();
}

/** Mutating callers hold the workspace gate before this shared account gate.
 * Read publication must never acquire a workspace gate after this point.
 * UI revocation uses the exclusive counterpart; identity/consent rows remain
 * held until commit or rollback. Never use a session-level pool lock. */
export async function requireMcpGrant(
  client: Pick<PoolClient, "query">,
  grant: McpGrant,
  userId: string,
) {
  if (
    grant.claims.sub !== userId ||
    typeof grant.claims.exp !== "number" ||
    !(await liveMcpGrant(client, grant, true))
  )
    throw new McpGrantError();
}

/** Only after requireMcpGrant retained all authority rows in this same open
 * transaction. Those rows cannot be revoked while held, but clocks advance
 * during provider I/O and target-lock waits. Keep the epoch check as well. */
export async function recheckRetainedMcpGrant(client: Pick<PoolClient, "query">, grant: McpGrant) {
  if (!(await liveMcpGrant(client, grant))) throw new McpGrantError();
}

/** Internal only: caller holds the exclusive account gate and has resolved an
 * existing, server-owned grant. Invalidate JWTs as well as stored credentials. */
export async function invalidateMcpGrant(
  client: Pick<PoolClient, "query">,
  userId: string,
  clientId: string,
  removeConsent = true,
) {
  const id = versionId(userId, clientId);
  await client.query(
    `insert into "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt")
    values ($1, $1, $2, now() + interval '100 years', now(), now())
    on conflict ("id") do update set "value" = excluded."value", "updatedAt" = now()`,
    [id, randomUUID()],
  );
  for (const table of [
    "oauthAccessToken",
    "oauthRefreshToken",
    ...(removeConsent ? ["oauthConsent"] : []),
  ])
    await client.query(`delete from "${table}" where "userId"=$1 and "clientId"=$2`, [
      userId,
      clientId,
    ]);
}

export async function revokeMcpAuthorization(userId: string, clientId: string) {
  if (typeof clientId !== "string" || !clientId || clientId.length > 2048)
    throw new PublicActionError("Choose an authorized agent.");
  await requireVerifiedUser(db, userId);
  await reservePersonalAttempts("oauth-revoke", userId);
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `mcp-consent:${userId}`,
    ]);
    await requireVerifiedUser(client, userId, true);
    const owned = await client.query(
      `select 1 where exists(select 1 from "oauthConsent" where "userId"=$1 and "clientId"=$2)
       or exists(select 1 from "oauthAccessToken" where "userId"=$1 and "clientId"=$2)
       or exists(select 1 from "oauthRefreshToken" where "userId"=$1 and "clientId"=$2)`,
      [userId, clientId],
    );
    // Unknown registrations cannot create permanent markers. Already revoked
    // grants need no new marker or token deletion and remain safe to repeat.
    if (!owned.rowCount) {
      await client.query("commit");
      return;
    }
    // The registration belongs to every account using the agent; keep it intact.
    await invalidateMcpGrant(client, userId, clientId);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export type AuthorizedClient = { clientId: string; name: string };
export async function authorizedClients(userId: string, resource: string) {
  await requireVerifiedUser(db, userId);
  await reservePersonalAttempts("oauth-authorizations", userId);
  return (
    await db.query<AuthorizedClient>(
      `select distinct c."clientId", coalesce(nullif(c."name", ''), 'Coding agent') as "name"
    from "oauthConsent" consent join "oauthClient" c on c."clientId" = consent."clientId"
    join "user" u on u."id"=consent."userId" and u."emailVerified"=true
    where consent."userId" = $1 and consent."resources" @> jsonb_build_array($2::text) and consent."scopes" ? 'mcp:read'
    order by c."clientId"`,
      [userId, resource],
    )
  ).rows;
}
