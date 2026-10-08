import { consumeMutationRateLimit } from "@/lib/auth/guard-client";
import type { RateDecision, RateRule } from "@/lib/auth/guard-store";
import { MutationBudgetError } from "@/lib/security/mutation-budget";

export class ClipboardBudgetUnavailableError extends Error {
  constructor() {
    super("Image copying is temporarily unavailable. Try again shortly.");
  }
}

export async function consumeClipboardBudget(
  userId: string,
  organizationId: string,
  consume: (scope: string, key: string, rule: RateRule) => Promise<RateDecision>,
) {
  for (const [scope, key, rule] of [
    [`clipboard-account:${userId}`, "minute", { window: 60, max: 10 }],
    [`clipboard-account:${userId}`, "hour", { window: 3600, max: 60 }],
    [`clipboard-workspace:${organizationId}`, "minute", { window: 60, max: 30 }],
    [`clipboard-workspace:${organizationId}`, "hour", { window: 3600, max: 300 }],
  ] as const) {
    const result = await consume(scope, key, rule);
    if (!result.allowed) throw new MutationBudgetError(result.retryAfter ?? 60);
  }
}

export async function reserveClipboardTransfer(userId: string, organizationId: string) {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return;
  try {
    await consumeClipboardBudget(userId, organizationId, consumeMutationRateLimit);
  } catch (error) {
    if (error instanceof MutationBudgetError) throw error;
    throw new ClipboardBudgetUnavailableError();
  }
}
