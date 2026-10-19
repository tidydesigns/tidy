import { consumeMutationRateLimitPair } from "../auth/guard-client";
import { OperationBudgetError } from "./operation-budget";
import { windowChecks, type BudgetConsumer } from "./worker-budget";

// Shared R2 ceilings complement the account/workspace operation limits.
export const AVATAR_STORAGE_LIMITS = { read: [1200, 30_000], write: [60, 1000] } as const;

export async function consumeAvatarStorage(kind: "read" | "write", consume: BudgetConsumer) {
  const [minute, hour] = AVATAR_STORAGE_LIMITS[kind];
  const decision = await consume(`avatar-storage:${kind}`, ...windowChecks("global", minute, hour));
  if (!decision.allowed) throw new OperationBudgetError(429, decision.retryAfter ?? 60);
}

/** Reserve before object I/O. Failed requests keep their charge. */
export async function reserveAvatarStorage(kind: "read" | "write") {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return;
  try {
    await consumeAvatarStorage(kind, consumeMutationRateLimitPair);
  } catch (error) {
    if (error instanceof OperationBudgetError) throw error;
    throw new OperationBudgetError(503, 5);
  }
}
