import { budgetShard, type BudgetEnvironment } from "../security/worker-budget";
import { waitForSignal } from "../request-lifecycle";

async function connectionGuard(env: BudgetEnvironment, userId: string) {
  const secret = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", secret, new TextEncoder().encode(userId));
  const owner = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { guard: env.AUTH_GUARD.getByName(`connections-v1:${await budgetShard(userId)}`), owner };
}
export async function acquireConnection(
  env: BudgetEnvironment,
  userId: string,
  sessionId: string,
  expiresAt: number,
) {
  const { guard, owner } = await connectionGuard(env, userId);
  return waitForSignal(
    guard.acquireConnection(owner, sessionId, expiresAt),
    AbortSignal.timeout(2000),
  );
}
export async function releaseConnection(env: BudgetEnvironment, userId: string, sessionId: string) {
  const { guard, owner } = await connectionGuard(env, userId);
  await waitForSignal(guard.releaseConnection(owner, sessionId), AbortSignal.timeout(2000));
}
