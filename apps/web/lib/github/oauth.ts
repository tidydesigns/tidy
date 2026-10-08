import { GitHubRequestError } from "./request-error";
import { db } from "@/lib/db";
import { githubConfig, githubConfigured } from "./config";
import { exchangeToken, storeUserToken } from "./client";
import { hash, pkceChallenge, randomToken, seal, unseal, type Sealed } from "./crypto";
import { organizationAccess, requireSchema } from "./connections";
import {
  requireOAuthSession,
  oauthVerifier,
  readOAuthVerifier,
} from "@/lib/connectors/oauth-session";
import { VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import { GITHUB_OAUTH_LIMITS, reserveGitHubOAuthAttempts } from "./oauth-budget";
import { boundedGitHubOperation } from "./work-budget";

export async function beginAuthorization(
  userId: string,
  organizationId: string,
  sessionId: string,
) {
  await requireSchema();
  if (!githubConfigured()) throw new GitHubRequestError("GitHub is not available yet.", 503);
  if (typeof organizationId !== "string" || !organizationId || organizationId.length > 200)
    throw new GitHubRequestError("Choose an organisation.");
  await organizationAccess(userId, organizationId);
  await requireOAuthSession(db, userId, sessionId);
  await reserveGitHubOAuthAttempts(userId, organizationId);
  const state = randomToken();
  const verifier = randomToken();
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [organizationId]);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `github-states:${userId}`,
    ]);
    await requireOAuthSession(client, userId, sessionId, true);
    const member = await client.query(
      `select 1 from "member" where "userId"=$1 and "organizationId"=$2 and "role" in ${VIEW_ROLES_SQL} for share`,
      [userId, organizationId],
    );
    if (member.rows.length !== 1) throw new GitHubRequestError("Workspace access denied.", 403);
    const capacity = await client.query<{ total: number; workspace: number }>(
      `select count(*)::int as total, count(*) filter(where "organizationId"=$2)::int as workspace
       from "githubOAuthState" where "userId"=$1 and "expiresAt">now()`,
      [userId, organizationId],
    );
    if (
      capacity.rows[0]!.total >= GITHUB_OAUTH_LIMITS.statesPerUser ||
      capacity.rows[0]!.workspace >= GITHUB_OAUTH_LIMITS.statesPerUserOrganization
    )
      throw new GitHubRequestError(
        "Too many pending GitHub sign-ins. Finish a sign-in or wait before trying again.",
        429,
      );
    await client.query(
      `delete from "githubOAuthState" where "hash" in
       (select "hash" from "githubOAuthState" where "userId"=$1 and "expiresAt"<now() order by "expiresAt" limit 1000)`,
      [userId],
    );
    await client.query(
      `insert into "githubOAuthState" ("hash","userId","organizationId","verifier","expiresAt") values ($1,$2,$3,$4,now() + interval '10 minutes')`,
      [
        hash(state),
        userId,
        organizationId,
        seal(oauthVerifier(verifier, sessionId), `${userId}:${hash(state)}`),
      ],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const config = githubConfig();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${config.origin}/api/github/callback`,
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return { state, url: url.href };
}
export const completeAuthorization = boundedGitHubOperation(async function completeAuthorization(
  userId: string,
  state: string | null,
  cookieState: string | undefined,
  code: string | null,
  sessionId: string,
) {
  await requireSchema();
  if (!state || state.length > 128 || state !== cookieState || !code || code.length > 4096)
    throw new GitHubRequestError(
      "Authorization could not be verified. Start Connect GitHub from Settings again.",
    );
  await requireOAuthSession(db, userId, sessionId);
  // Claim once without removing disconnect's ability to revoke pending authority.
  const stored = await db.query<{ organizationId: string; verifier: Sealed }>(
    `update "githubOAuthState" set "verifier"="verifier" || '{"claimed":true}'::jsonb
     where "hash"=$1 and "userId"=$2 and "expiresAt">now() and not ("verifier" ? 'claimed')
     returning "organizationId","verifier"`,
    [hash(state), userId],
  );
  const row = stored.rows[0];
  if (!row) throw new GitHubRequestError("Authorization expired. Connect GitHub again.");
  try {
    const verifier = readOAuthVerifier(unseal(row.verifier, `${userId}:${hash(state)}`), sessionId);
    await organizationAccess(userId, row.organizationId);
    const token = await exchangeToken({
      code,
      redirect_uri: `${githubConfig().origin}/api/github/callback`,
      code_verifier: verifier,
    });
    await storeUserToken(userId, token, {
      sessionId,
      organizationId: row.organizationId,
      stateHash: hash(state),
    });
    return { organizationId: row.organizationId };
  } finally {
    await db
      .query('delete from "githubOAuthState" where "hash"=$1 and "userId"=$2', [
        hash(state),
        userId,
      ])
      .catch(() => {});
  }
});
