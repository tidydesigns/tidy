import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { APIError, createAuthEndpoint } from "better-auth/api";
import type { mcp } from "@better-auth/mcp";
import { z } from "zod";
import { db } from "@/lib/db";
import { authorizationVersion, invalidateMcpGrant } from "@/lib/mcp/authorizations";
import { verifyConsentQuery } from "@/lib/design/verify-consent-query";
import { requireVerifiedUser } from "@/lib/security/user-authority";
import { PersonalBudgetError, reservePersonalAttempts } from "@/lib/security/personal-budget";
import {
  invalidOAuthGrant,
  oauthAccountGate,
  oauthFailure,
  oauthTransaction,
} from "./oauth-transaction";

type Provider = ReturnType<typeof mcp>;
type Approval = {
  userId: string;
  sessionId: string;
  clientId: string;
  queryHash: string;
  version: string;
  expiresAt: number;
};

function queryHash(query: string) {
  // Canonical request fingerprint, authenticated by the consent proof's HMAC.
  if (Buffer.byteLength(query) > 16_384) throw invalidOAuthGrant();
  const params = new URLSearchParams(query);
  params.sort();
  return createHash("sha256").update(params.toString()).digest("base64url");
}
function signature(payload: string, secret: string) {
  // HMAC authenticates this short-lived proof; this is not password storage.
  return createHmac("sha256", secret).update(`tidy-consent:${payload}`).digest();
}
async function liveSession(userId: string, sessionId: string) {
  const session = (
    await db.query<{ expiresAt: Date }>(
      'select "expiresAt" from "session" where "id"=$1 and "userId"=$2 and "expiresAt">clock_timestamp() for share',
      [sessionId, userId],
    )
  ).rows[0];
  if (!session) throw new APIError("UNAUTHORIZED");
  return session;
}

/** Called only by the server-rendered consent page after resolving its cookie
 * session. Bind the displayed query to that exact live account/session/epoch.
 * No pending-state rows: accepting rotates the epoch and consumes this proof. */
export async function createConsentApproval(
  userId: string,
  sessionId: string,
  query: string,
  secret: string,
) {
  const params = new URLSearchParams(query);
  const hash = queryHash(query);
  if (!(await verifyConsentQuery(params, secret))) throw invalidOAuthGrant();
  const clientId = params.get("client_id");
  if (!clientId || clientId.length > 2048) throw invalidOAuthGrant();
  return oauthTransaction(async () => {
    await db.query("select pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
      `mcp-consent:${userId}`,
    ]);
    await requireVerifiedUser(db, userId, true);
    const session = await liveSession(userId, sessionId);
    const approval: Approval = {
      userId,
      sessionId,
      clientId,
      queryHash: hash,
      version: await authorizationVersion(userId, clientId),
      expiresAt: Math.min(
        Number(params.get("exp")) * 1000,
        Date.now() + 300_000,
        session.expiresAt.getTime(),
      ),
    };
    if (!Number.isFinite(approval.expiresAt) || approval.expiresAt <= Date.now())
      throw invalidOAuthGrant();
    await liveSession(userId, sessionId);
    const payload = Buffer.from(JSON.stringify(approval)).toString("base64url");
    return `${payload}.${signature(payload, secret).toString("base64url")}`;
  });
}

function verifyApproval(token: string, secret: string): Approval {
  const parts = token.split(".");
  if (parts.length !== 2) throw invalidOAuthGrant();
  const supplied = Buffer.from(parts[1], "base64url"),
    expected = signature(parts[0], secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw invalidOAuthGrant();
  let value: Approval;
  try {
    value = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  } catch {
    throw invalidOAuthGrant();
  }
  if (
    !value ||
    ![value.userId, value.sessionId, value.clientId, value.queryHash, value.version].every(
      (field) => typeof field === "string" && field.length > 0 && field.length <= 2048,
    ) ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= Date.now()
  )
    throw invalidOAuthGrant();
  return value;
}

export function oauthConsentEndpoint(endpoint: Provider["endpoints"]["oauth2Consent"]) {
  return createAuthEndpoint(
    endpoint.path,
    {
      ...endpoint.options,
      body: endpoint.options.body.extend({ tidy_consent: z.string().min(1).max(8192) }),
    },
    async (ctx) => {
      try {
        const session = ctx.context.session;
        if (!session) throw new APIError("UNAUTHORIZED");
        const approval = verifyApproval(ctx.body.tidy_consent, ctx.context.secret);
        if (
          approval.userId !== session.user.id ||
          approval.sessionId !== session.session.id ||
          typeof ctx.body.oauth_query !== "string" ||
          approval.queryHash !== queryHash(ctx.body.oauth_query)
        )
          throw invalidOAuthGrant();
        try {
          await reservePersonalAttempts("oauth-revoke", session.user.id);
        } catch (error) {
          if (!(error instanceof PersonalBudgetError)) throw error;
          throw new APIError(error.status === 429 ? "TOO_MANY_REQUESTS" : "SERVICE_UNAVAILABLE", {
            message: error.message,
          });
        }
        return await oauthTransaction(async () => {
          await oauthAccountGate(approval.userId);
          await requireVerifiedUser(db, approval.userId, true);
          await liveSession(approval.userId, approval.sessionId);
          if (
            approval.expiresAt <= Date.now() ||
            approval.version !== (await authorizationVersion(approval.userId, approval.clientId))
          )
            throw invalidOAuthGrant();
          if (ctx.body.accept) {
            // Rotate before code insertion. One accepted proof cannot mint more
            // codes or restore older tokens when scopes are narrowed/restored.
            const known = await db.query(
              'select 1 from "oauthClient" where "clientId"=$1 and "disabled" is not true',
              [approval.clientId],
            );
            if (!known.rowCount) throw invalidOAuthGrant();
            await invalidateMcpGrant(db, approval.userId, approval.clientId, false);
          }
          const result = await endpoint({
            ...ctx,
            asResponse: false,
            returnHeaders: true,
            returnStatus: true,
          });
          if (
            ctx.body.accept &&
            (!result.response.url || !new URL(result.response.url).searchParams.has("code"))
          )
            throw invalidOAuthGrant();
          // Code insertion already retains client/resource/consent authority.
          // Denials perform no grant mutation. Repeat the session/proof clocks.
          await liveSession(approval.userId, approval.sessionId);
          if (approval.expiresAt <= Date.now()) throw invalidOAuthGrant();
          result.headers.forEach((value, key) => ctx.setHeader(key, value));
          if (result.status) ctx.setStatus(result.status as Parameters<typeof ctx.setStatus>[0]);
          return result.response;
        });
      } catch (error) {
        oauthFailure(error);
      }
    },
  );
}
