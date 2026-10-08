import { consumeMutationRateLimit } from "@/lib/auth/guard-client";
import type { RateRule, RateDecision } from "@/lib/auth/guard-store";
import { ConnectorError } from "@/lib/connectors/error";
import { LINEAR_LIMITS } from "@/lib/security/resource-limits";

export async function consumeLinearAttempts(
  kind: "read" | "write" | "oauth",
  userId: string,
  organizationId: string,
  consume: (scope: string, key: string, rule: RateRule) => Promise<RateDecision>,
) {
  const rule = LINEAR_LIMITS.attempts[kind];
  for (const [scope, key, window, max] of [
    [`linear-${kind}-account:${userId}`, "minute", 60, rule.accountMinute],
    [`linear-${kind}-account:${userId}`, "hour", 3600, rule.accountHour],
    [`linear-${kind}-workspace:${organizationId}`, "minute", 60, rule.workspaceMinute],
    [`linear-${kind}-workspace:${organizationId}`, "hour", 3600, rule.workspaceHour],
  ] as const) {
    const decision = await consume(scope, key, { window, max });
    if (!decision.allowed)
      throw new ConnectorError("Too many Linear requests. Try again shortly.", 429);
  }
}
export async function reserveLinearAttempts(
  kind: "read" | "write" | "oauth",
  userId: string,
  organizationId: string,
) {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return;
  try {
    await consumeLinearAttempts(kind, userId, organizationId, consumeMutationRateLimit);
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("Linear is temporarily unavailable. Try again.", 503);
  }
}
