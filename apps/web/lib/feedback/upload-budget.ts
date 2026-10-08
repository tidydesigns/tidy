import { consumeMutationRateLimit } from "@/lib/auth/guard-client";
import type { RateDecision, RateRule } from "@/lib/auth/guard-store";
import { MutationBudgetError } from "@/lib/security/mutation-budget";

/** Charge attempts before reading multipart bytes, including malformed uploads and retries. */
export async function reserveFeedbackUpload(userId: string) {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return;
  await consumeFeedbackBudget(userId, consumeMutationRateLimit);
}

export async function consumeFeedbackBudget(
  userId: string,
  consume: (scope: string, key: string, rule: RateRule) => Promise<RateDecision>,
) {
  // Separate account shards bound counter cardinality and keep feedback out of auth counters.
  for (const [scope, key, rule] of [
    [`feedback-account:${userId}`, "minute", { window: 60, max: 5 }],
    [`feedback-account:${userId}`, "hour", { window: 3600, max: 40 }],
    ["feedback-global", "minute", { window: 60, max: 30 }],
    ["feedback-global", "hour", { window: 3600, max: 200 }],
  ] as const) {
    const result = await consume(scope, key, rule);
    if (!result.allowed) throw new MutationBudgetError(result.retryAfter ?? 60);
  }
}
