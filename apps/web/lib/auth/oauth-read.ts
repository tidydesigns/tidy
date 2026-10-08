import "server-only";
import { APIError, createAuthEndpoint, isAPIError } from "better-auth/api";
import { getOAuthProviderApi } from "@better-auth/oauth-provider";
import { decodeBasicCredentials } from "@better-auth/core/oauth2";
import type { mcp } from "@better-auth/mcp";
import { decodeJwt } from "jose";
import { db } from "@/lib/db";
import { authorizationVersion, McpGrantError, requireMcpGrant } from "@/lib/mcp/authorizations";
import { oauthFailure, oauthTransaction } from "./oauth-transaction";

type Provider = ReturnType<typeof mcp>;
type Context = Parameters<typeof getOAuthProviderApi>[0];
type ClientSnapshot = {
  clientId: string;
  secret: string | null;
  method: string | null;
  jwks: string | null;
  jwksUri: string | null;
};

/** This is only a lookup hint for a credential snapshot, not authentication.
 * The native endpoint must subsequently verify the exact request once. Use the
 * pinned provider's Basic decoder and assertion subject precedence; malformed
 * or conflicting credentials still receive its normal protocol error. Tidy has
 * no extension client-authentication strategies. */
async function introspectionClient(ctx: Context, options: Provider["options"]) {
  let id: unknown = ctx.body?.client_id;
  try {
    if (ctx.body?.client_assertion) {
      const claims = decodeJwt(ctx.body.client_assertion);
      id = claims.sub ?? claims.iss;
    } else {
      const header = ctx.request?.headers.get("authorization");
      if (header && /^Basic\s+/i.test(header)) id = decodeBasicCredentials(header).clientId;
    }
  } catch {
    return;
  }
  if (typeof id !== "string" || !id || id.length > 2048) return;
  const client = await getOAuthProviderApi(ctx, options).getClient(id);
  if (!client) return;
  return {
    clientId: id,
    secret: client.clientSecret ?? null,
    method: client.tokenEndpointAuthMethod ?? null,
    jwks:
      typeof client.jwks === "string"
        ? client.jwks
        : client.jwks
          ? JSON.stringify(client.jwks)
          : null,
    jwksUri: client.jwksUri ?? null,
  } satisfies ClientSnapshot;
}

async function retainIntrospectionClient(client: ClientSnapshot) {
  const current = await db.query(
    `select "clientId" from "oauthClient" where "clientId"=$1
     and "disabled" is not true and "clientSecret" is not distinct from $2
     and "tokenEndpointAuthMethod" is not distinct from $3
     and "jwks" is not distinct from $4 and "jwksUri" is not distinct from $5 for share`,
    [client.clientId, client.secret, client.method, client.jwks, client.jwksUri],
  );
  if (!current.rowCount)
    throw new APIError("BAD_REQUEST", {
      error: "invalid_client",
      error_description: "Client authentication has changed. Authenticate again.",
    });
}
type StoredToken = {
  id: string;
  userId: string | null;
  clientId: string | null;
  sessionId: string | null;
  expiresAt: Date | null;
  scopes: string[];
  resources: string[] | null;
  revoked: boolean | null;
};
const ended = () =>
  new APIError(
    "UNAUTHORIZED",
    {
      error: "invalid_token",
      error_description: "Authorization has ended. Authorize again to reconnect.",
    },
    { "WWW-Authenticate": 'Bearer error="invalid_token"' },
  );

/** The provider performs protocol authentication, signature and DPoP checks.
 * Before publishing its read, retain Tidy's current grant authority.
 * Discovery stays outside row locks because it may refresh client metadata. */
async function retainToken(
  ctx: Context,
  options: Provider["options"],
  raw: string,
  hint?: string,
  introspectingClient?: ClientSnapshot,
) {
  if (!raw || raw.length > 4096) throw ended();
  // The pinned provider calls getJwks(ctx) and reads its response envelope.
  // Retain that internal calling convention for both HTTP and server APIs.
  const providerCtx = { ...ctx, asResponse: false, returnHeaders: true };
  const provider = getOAuthProviderApi(providerCtx, options);
  const lookup = async (
    table: "oauthAccessToken" | "oauthRefreshToken",
    token: string,
    lock = false,
  ) =>
    (
      await db.query<StoredToken>(
        `select "id","userId","clientId","sessionId","expiresAt","scopes","resources","revoked"
       from "${table}" where "token"=$1${lock ? " for share" : ""}`,
        [token],
      )
    ).rows[0];
  let table: "oauthAccessToken" | "oauthRefreshToken" = "oauthAccessToken";
  let identifier = await provider.hashToken(raw, "access_token");
  let source = hint === "refresh_token" ? undefined : await lookup(table, identifier);
  if (!source && hint !== "access_token") {
    table = "oauthRefreshToken";
    identifier = await provider.hashToken(raw, "refresh_token");
    source = await lookup(table, identifier);
  }
  // Use only a database-owned token or provider-verified claims, never an
  // unsigned JWT decode or the pairwise subject in the presentation response.
  const claims: Record<string, unknown> = source
    ? {
        sub: source.userId,
        client_id: source.clientId,
        sid: source.sessionId,
        exp: source.expiresAt ? source.expiresAt.getTime() / 1000 : 0,
      }
    : await provider.validateAccessToken(raw);
  if (!source && !claims.active) throw ended();
  const scopes =
    source?.scopes ??
    (typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : []);
  const userInfo = `${ctx.context.baseURL}/oauth2/userinfo`;
  const audience =
    source?.resources ?? (typeof claims.aud === "string" ? [claims.aud] : claims.aud);
  const resources = Array.isArray(audience)
    ? audience.filter((value): value is string => typeof value === "string" && value !== userInfo)
    : [];
  if (!resources.length || typeof claims.sub !== "string" || typeof claims.client_id !== "string")
    throw ended();
  const userId = claims.sub;
  const clientId = claims.client_id;
  // Resource links permit a client to request MCP access; they do not appoint
  // it as an introspection resource server. Tidy introspection is issuer-only.
  // Reject foreign callers before taking any other account's authority locks.
  if (introspectingClient && introspectingClient.clientId !== clientId) throw ended();
  await oauthTransaction(async () => {
    // Canonical checks take the shared account gate first; issuance/revocation
    // takes its exclusive counterpart, so stored tokens cannot be resurrected.
    const grant = {
      claims: {
        ...claims,
        bella_grant_version: source
          ? await authorizationVersion(userId, clientId)
          : claims.bella_grant_version,
      },
      scopes: scopes.filter((scope) => /^(mcp|linear):/.test(scope)),
      resource: resources[0],
    };
    try {
      for (const resource of resources) await requireMcpGrant(db, { ...grant, resource }, userId);
    } catch (error) {
      if (error instanceof McpGrantError) throw ended();
      throw error;
    }
    if (introspectingClient) await retainIntrospectionClient(introspectingClient);
    if (source) {
      const current = await lookup(table, identifier, true);
      if (
        !current ||
        current.revoked ||
        current.id !== source.id ||
        current.userId !== userId ||
        current.clientId !== clientId ||
        current.sessionId !== source.sessionId ||
        !current.expiresAt ||
        current.expiresAt.getTime() <= Date.now() ||
        JSON.stringify(current.scopes) !== JSON.stringify(source.scopes) ||
        JSON.stringify(current.resources) !== JSON.stringify(source.resources)
      )
        throw ended();
    }
    // OIDC profile scopes authorize identity disclosure too. Resource policies
    // govern product scopes; client registration and consent must retain all.
    const retainedScopes = await db.query(
      `select 1 from "oauthConsent" consent join "oauthClient" client on client."clientId"=consent."clientId"
       where consent."userId"=$1 and consent."clientId"=$2 and consent."scopes" ?& $3::text[]
       and (client."scopes" is null or client."scopes" ?& $3::text[]) for share of consent,client`,
      [userId, clientId, scopes],
    );
    if (!retainedScopes.rowCount) throw ended();
    // Row admission itself may queue long enough for a token/session to expire.
    try {
      for (const resource of resources) await requireMcpGrant(db, { ...grant, resource }, userId);
    } catch (error) {
      if (error instanceof McpGrantError) throw ended();
      throw error;
    }
  });
}

export function oauthUserInfoEndpoint(
  endpoint: Provider["endpoints"]["oauth2UserInfo"],
  options: Provider["options"],
) {
  return createAuthEndpoint(endpoint.path, endpoint.options, async (ctx) => {
    try {
      const raw =
        ctx.headers?.get("authorization")?.replace(/^(Bearer|DPoP)\s+/i, "") ??
        ctx.body?.access_token;
      if (typeof raw === "string" && raw.length > 4096) throw ended();
      const result = await endpoint({
        ...ctx,
        asResponse: false,
        returnHeaders: true,
        returnStatus: true,
      });
      if (typeof raw !== "string") throw ended();
      await retainToken(ctx, options, raw, "access_token");
      result.headers.forEach((value, key) => ctx.setHeader(key, value));
      if (result.status) ctx.setStatus(result.status as Parameters<typeof ctx.setStatus>[0]);
      return result.response;
    } catch (error) {
      oauthFailure(error);
    }
  });
}

export function oauthIntrospectionEndpoint(
  endpoint: Provider["endpoints"]["oauth2Introspect"],
  options: Provider["options"],
) {
  return createAuthEndpoint(endpoint.path, endpoint.options, async (ctx) => {
    try {
      // Keep the provider's exact credential/assertion authentication and
      // response filtering, including pairwise subjects. Do not authenticate
      // again: private-key assertions and DPoP proofs are single use.
      if (ctx.body.token.length > 4096)
        throw new APIError("BAD_REQUEST", { error: "invalid_request" });
      // Snapshot discovery stays outside authority locks. The native endpoint
      // authenticates this request, including single-use assertions, once.
      const client = await introspectionClient(ctx, options);
      const result = await endpoint({
        ...ctx,
        asResponse: false,
        returnHeaders: true,
        returnStatus: true,
      });
      result.headers.forEach((value, key) => ctx.setHeader(key, value));
      if (result.status) ctx.setStatus(result.status as Parameters<typeof ctx.setStatus>[0]);
      if (!result.response.active) return result.response;
      if (!client || client.clientId !== result.response.client_id) return { active: false };
      const raw = ctx.body.token.replace(/^(Bearer|DPoP)\s+/i, "");
      await retainToken(ctx, options, raw, ctx.body.token_type_hint, client);
      return result.response;
    } catch (error) {
      if (isAPIError(error) && error.statusCode === 401 && error.body?.error === "invalid_token")
        return { active: false };
      oauthFailure(error);
    }
  });
}
