import "server-only";
import type { PoolClient } from "pg";
import { PublicActionError } from "@/lib/security/public-error";

export class OAuthSessionError extends PublicActionError {
  readonly status = 403;
  constructor() {
    super("Authorization expired. Start the connection again from Settings.");
  }
}

export async function requireOAuthSession(
  client: Pick<PoolClient, "query">,
  userId: string,
  sessionId: string,
  lock = false,
) {
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256)
    throw new OAuthSessionError();
  const session = await client.query(
    `select 1 from "session" s join "user" u on u."id"=s."userId" and u."emailVerified"=true
     where s."id"=$1 and s."userId"=$2 and s."expiresAt">clock_timestamp()
     ${lock ? "for share of s,u" : ""}`,
    [sessionId, userId],
  );
  if (session.rows.length !== 1) throw new OAuthSessionError();
}

/** This envelope is encrypted with the existing provider/user/state AAD.
 * Old verifier-only states intentionally fail closed and must be restarted. */
export function oauthVerifier(verifier: string, sessionId: string) {
  return JSON.stringify({ version: 1, verifier, sessionId });
}
export function readOAuthVerifier(value: string, sessionId: string): string {
  try {
    const data = JSON.parse(value);
    if (
      data?.version === 1 &&
      typeof data.sessionId === "string" &&
      data.sessionId === sessionId &&
      typeof data.verifier === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(data.verifier)
    )
      return data.verifier;
  } catch {
    // A legacy or malformed envelope is not authority.
  }
  throw new OAuthSessionError();
}
