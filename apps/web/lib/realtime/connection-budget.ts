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
  waitUntil: (task: Promise<unknown>) => void,
) {
  const { guard, owner } = await connectionGuard(env, userId);
  return acquireLeaseWithCleanup(
    guard,
    owner,
    sessionId,
    expiresAt,
    AbortSignal.timeout(2000),
    waitUntil,
  );
}

type LeaseGuard = {
  acquireConnection(owner: string, id: string, expiresAt: number): Promise<boolean>;
  releaseConnection(owner: string, id: string): Promise<void>;
};

/** A timeout stops waiting, not the RPC. Release only a confirmed late success;
 * a denied duplicate ticket must never release the existing connection. */
export async function acquireLeaseWithCleanup(
  guard: LeaseGuard,
  owner: string,
  id: string,
  expiresAt: number,
  signal: AbortSignal,
  waitUntil: (task: Promise<unknown>) => void,
) {
  const pending = guard.acquireConnection(owner, id, expiresAt);
  try {
    return await waitForSignal(pending, signal);
  } catch (error) {
    waitUntil(
      pending
        .then(async (acquired) => {
          if (acquired) await guard.releaseConnection(owner, id);
        })
        .catch(() => {}),
    );
    throw error;
  }
}
export async function releaseConnection(env: BudgetEnvironment, userId: string, sessionId: string) {
  const { guard, owner } = await connectionGuard(env, userId);
  await waitForSignal(guard.releaseConnection(owner, sessionId), AbortSignal.timeout(2000));
}
