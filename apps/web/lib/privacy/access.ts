import { RequestBodyError } from "@/lib/http/request-body";
import "server-only";
import { auth } from "@/lib/auth";
import { PublicActionError } from "@/lib/security/public-error";
import { PersonalBudgetError, reservePersonalAttempts } from "@/lib/security/personal-budget";
import type { PoolClient } from "pg";

export class PrivacyError extends PublicActionError {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export async function privacyAccount(
  request: Request,
  operation: "privacy-export" | "privacy-delete",
) {
  // Next.js/proxies can expose an internal request URL. Use the configured public
  // origin, never a caller-supplied Host or forwarded header, for the CSRF boundary.
  if (
    request.headers.get("origin") !== new URL(process.env.BETTER_AUTH_URL || request.url).origin ||
    request.headers.get("x-tidy-privacy") !== "1"
  )
    throw new PrivacyError("Reload Tidy at its configured app address and try again.", 403);
  const session = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (!session) throw new PrivacyError("Sign in to manage your data.", 401);
  await reservePersonalAttempts(operation, session.user.id);
  return session;
}

export async function lockPrivacyAccount(client: PoolClient, userId: string, sessionId: string) {
  // Recheck persisted session and user inside the transaction, after acquiring locks.
  const user = (
    await client.query<{ id: string; email: string; name: string; image: string | null }>(
      'select id,email,name,image from "user" where id=$1 and "emailVerified"=true for update',
      [userId],
    )
  ).rows[0];
  const session = (
    await client.query(
      `select id from "session" where id=$1 and "userId"=$2 and "expiresAt">clock_timestamp()
     and "createdAt">clock_timestamp()-interval '5 minutes' for share`,
      [sessionId, userId],
    )
  ).rows[0];
  if (!user || !session)
    throw new PrivacyError("Sign out and sign in again, then retry within five minutes.", 401);
  return user;
}
export function privacyFailure(error: unknown) {
  const known =
    error instanceof PrivacyError ||
    error instanceof PersonalBudgetError ||
    error instanceof RequestBodyError;
  if (!known) console.error(JSON.stringify({ event: "privacy_request_failed" }));
  return Response.json(
    { error: known ? error.message : "Could not complete your privacy request. Please try again." },
    { status: known ? error.status : 500, headers: privateHeaders },
  );
}
