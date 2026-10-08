import { consumeMutationRateLimit } from "@/lib/auth/guard-client";
import type { RateDecision, RateRule } from "@/lib/auth/guard-store";
import { MutationBudgetError } from "@/lib/security/mutation-budget";
import { FILE_MANAGEMENT_LIMITS as limits } from "@/lib/security/resource-limits";

export class FileManagementBudgetUnavailableError extends Error {
  constructor() {
    super("File changes are temporarily unavailable. Try again shortly.");
  }
}

export async function consumeFileManagementBudget(
  userId: string,
  organizationId: string,
  consume: (scope: string, key: string, rule: RateRule) => Promise<RateDecision>,
) {
  for (const [scope, key, rule] of [
    [`file-management-account:${userId}`, "minute", { window: 60, max: limits.accountMinute }],
    [`file-management-account:${userId}`, "hour", { window: 3600, max: limits.accountHour }],
    [
      `file-management-workspace:${organizationId}`,
      "minute",
      { window: 60, max: limits.workspaceMinute },
    ],
    [
      `file-management-workspace:${organizationId}`,
      "hour",
      { window: 3600, max: limits.workspaceHour },
    ],
  ] as const) {
    const decision = await consume(scope, key, rule);
    if (!decision.allowed) throw new MutationBudgetError(decision.retryAfter ?? 60);
  }
}

export async function reserveFileManagement(userId: string, organizationId: string) {
  // Hosted Worker adapter; another production runtime requires a shared adapter.
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return;
  try {
    await consumeFileManagementBudget(userId, organizationId, consumeMutationRateLimit);
  } catch (error) {
    if (error instanceof MutationBudgetError) throw error;
    throw new FileManagementBudgetUnavailableError();
  }
}
