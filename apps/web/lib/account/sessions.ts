import { PublicActionError } from "@/lib/security/public-error";
import "server-only";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { reservePersonalAttempts } from "@/lib/security/personal-budget";
import { requireVerifiedUser } from "@/lib/security/user-authority";

export async function revokeOtherAccountSession(
  userId: string,
  currentSessionId: string,
  targetId: string,
  requestHeaders: Headers,
) {
  await requireVerifiedUser(db, userId);
  await reservePersonalAttempts("session-revoke", userId);
  if (typeof targetId !== "string" || !targetId || targetId.length > 256)
    throw new PublicActionError("Session not found.");
  if (targetId === currentSessionId)
    throw new PublicActionError("Use Sign out to end your current session.");
  const target = (
    await db.query<{ token: string }>(
      'select s."token" from "session" s join "user" u on u."id"=s."userId" and u."emailVerified"=true where s."id" = $1 and s."userId" = $2',
      [targetId, userId],
    )
  ).rows[0];
  if (!target) throw new PublicActionError("Session not found.");
  await auth.api.revokeSession({ headers: requestHeaders, body: { token: target.token } });
}

export async function listAccountSessions(userId: string) {
  await requireVerifiedUser(db, userId);
  await reservePersonalAttempts("account-sessions", userId);
  const result = await db.query<{
    id: string;
    createdAt: Date;
    expiresAt: Date;
    userAgent: string | null;
    ipAddress: string | null;
  }>(
    'select s."id", s."createdAt", s."expiresAt", s."userAgent", s."ipAddress" from "session" s join "user" u on u."id"=s."userId" and u."emailVerified"=true where s."userId"=$1 and s."expiresAt">now() order by s."createdAt" desc',
    [userId],
  );
  return result.rows.map((item) => ({
    ...item,
    createdAt: item.createdAt.toISOString(),
    expiresAt: item.expiresAt.toISOString(),
  }));
}
