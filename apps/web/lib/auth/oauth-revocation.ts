import "server-only";
import { APIError, createAuthEndpoint, isAPIError } from "better-auth/api";
import { getOAuthProviderApi } from "@better-auth/oauth-provider";
import type { mcp } from "@better-auth/mcp";
import { errors, type JWTPayload } from "jose";
import { db } from "@/lib/db";
import { authorizationVersion, invalidateMcpGrant } from "@/lib/mcp/authorizations";
import { oauthAccountGate, oauthFailure, oauthTransaction } from "./oauth-transaction";

type Provider = ReturnType<typeof mcp>;
type StoredToken = {
  id: string;
  userId: string | null;
  clientId: string | null;
  expiresAt: Date | null;
};

/** RFC 7009: authenticate once with the provider's public capability, then
 * bind mutation to stored ownership or verified JWT claims. Unknown/already
 * invalid tokens return the same empty success without creating grant markers. */
export function oauthRevocationEndpoint(
  endpoint: Provider["endpoints"]["oauth2Revoke"],
  options: Provider["options"],
) {
  return createAuthEndpoint(endpoint.path, endpoint.options, async (ctx) => {
    try {
      const raw = ctx.body.token.replace(/^Bearer\s+/i, "");
      if (!raw || raw.length > 4096)
        throw new APIError("BAD_REQUEST", {
          error: "invalid_request",
          error_description: "Invalid token.",
        });
      const provider = getOAuthProviderApi(ctx, options);
      // Discovery/authentication may update client metadata. Finish that work
      // before retaining product-authority rows, then bind its exact credential
      // snapshot under a client lock. Foreign-client requests never lock another
      // account's grant or enter a source/target client lock cycle.
      const authenticated = await provider.authenticateClient({ requireCredentials: false });
      const refreshId = await provider.hashToken(raw, "refresh_token");
      const accessId = await provider.hashToken(raw, "access_token");
      const lookup = async (table: "oauthRefreshToken" | "oauthAccessToken", identifier: string) =>
        (
          await db.query<StoredToken>(
            `select "id","userId","clientId","expiresAt" from "${table}" where "token"=$1`,
            [identifier],
          )
        ).rows[0];
      const refresh = await lookup("oauthRefreshToken", refreshId);
      const access = refresh ? undefined : await lookup("oauthAccessToken", accessId);
      const stored = refresh ?? access;
      let claims: JWTPayload | undefined;
      if (!stored && raw.split(".").length === 3) {
        try {
          const payload = await provider.validateAccessToken(raw);
          if (
            payload.active &&
            typeof payload.sub === "string" &&
            typeof payload.client_id === "string"
          )
            claims = payload;
        } catch (error) {
          // Invalid signatures/expired tokens are neutral, never a decoded actor.
          // Database, transport and unknown errors still fail closed below.
          if (
            !(error instanceof errors.JOSEError) &&
            !(isAPIError(error) && (error.statusCode === 400 || error.statusCode === 401))
          )
            throw error;
        }
      }
      const userId = stored?.userId ?? claims?.sub;
      const clientId = stored?.clientId ?? claims?.client_id;
      if (!clientId || authenticated.clientId !== clientId) return null;
      return await oauthTransaction(async () => {
        await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `oauth-issuance:${refresh ? "refresh_token" : "access_token"}:${refresh ? refreshId : accessId}`,
        ]);
        if (userId) {
          await oauthAccountGate(userId);
          await db.query('select "id" from "user" where "id"=$1 for share', [userId]);
        }
        const proved = authenticated.client;
        const jwks =
          typeof proved.jwks === "string"
            ? proved.jwks
            : proved.jwks
              ? JSON.stringify(proved.jwks)
              : null;
        const currentClient = await db.query(
          `select "clientId" from "oauthClient" where "clientId"=$1
          and "disabled" is not true and "clientSecret" is not distinct from $2
          and "tokenEndpointAuthMethod" is not distinct from $3
          and "jwks" is not distinct from $4 and "jwksUri" is not distinct from $5
          for share`,
          [
            clientId,
            proved.clientSecret ?? null,
            proved.tokenEndpointAuthMethod ?? null,
            jwks,
            proved.jwksUri ?? null,
          ],
        );
        if (!currentClient.rowCount)
          throw new APIError("BAD_REQUEST", {
            error: "invalid_client",
            error_description: "Client authentication has changed. Authenticate again.",
          });
        if (stored) {
          const current = await lookup(
            refresh ? "oauthRefreshToken" : "oauthAccessToken",
            refresh ? refreshId : accessId,
          );
          if (
            !current ||
            current.id !== stored.id ||
            current.userId !== stored.userId ||
            current.clientId !== clientId
          )
            return null;
          if (!current.expiresAt || current.expiresAt.getTime() <= Date.now()) return null;
          if (!userId) {
            // Userless opaque credentials cannot create a personal grant marker.
            await db.query('delete from "oauthAccessToken" where "id"=$1 and "clientId"=$2', [
              stored.id,
              clientId,
            ]);
            return null;
          }
        } else if (claims && userId) {
          // An old signed token must not revoke a newly consented generation.
          if (
            (claims.bella_grant_version ?? "0") !== (await authorizationVersion(userId, clientId))
          )
            return null;
        } else return null;
        // A valid signature alone does not enroll permanent application state.
        const owned = await db.query(
          `select 1 where
          exists(select 1 from "oauthConsent" where "userId"=$1 and "clientId"=$2) or
          exists(select 1 from "oauthRefreshToken" where "userId"=$1 and "clientId"=$2) or
          exists(select 1 from "oauthAccessToken" where "userId"=$1 and "clientId"=$2)`,
          [userId, clientId],
        );
        if (owned.rowCount) await invalidateMcpGrant(db, userId!, clientId);
        return null;
      });
    } catch (error) {
      oauthFailure(error);
    }
  });
}
