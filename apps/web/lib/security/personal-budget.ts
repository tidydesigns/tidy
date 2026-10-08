import { consumeMutationRateLimit } from "@/lib/auth/guard-client";
import type { RateDecision, RateRule } from "@/lib/auth/guard-store";
import { PublicActionError } from "./public-error";

export const PERSONAL_ATTEMPTS = {
  "account-sessions": { minute: 120, hour: 3600 },
  "session-revoke": { minute: 20, hour: 100 },
  "oauth-authorizations": { minute: 120, hour: 3600 },
  "oauth-revoke": { minute: 20, hour: 200 },
  "vault-read": { minute: 120, hour: 3600 },
  "vault-write": { minute: 60, hour: 1000 },
  "agent-status": { minute: 120, hour: 3600 },
  "agent-refresh": { minute: 120, hour: 3600 },
  "agent-login": { minute: 6, hour: 30 },
  "agent-disconnect": { minute: 10, hour: 100 },
} as const;
export type PersonalOperation = keyof typeof PERSONAL_ATTEMPTS;
export class PersonalBudgetError extends PublicActionError {
  constructor(public status: 429 | 503) {
    super(
      status === 429
        ? "Too many account requests. Try again shortly."
        : "Account requests are temporarily unavailable. Try again.",
    );
  }
}
export async function consumePersonalAttempts(
  kind: PersonalOperation,
  userId: string,
  consume: (scope: string, key: string, rule: RateRule) => Promise<RateDecision>,
) {
  const limits = PERSONAL_ATTEMPTS[kind];
  for (const [key, window, max] of [
    ["minute", 60, limits.minute],
    ["hour", 3600, limits.hour],
  ] as const) {
    if (!(await consume(`personal-${kind}:${userId}`, key, { window, max })).allowed)
      throw new PersonalBudgetError(429);
  }
}
export async function reservePersonalAttempts(kind: PersonalOperation, userId: string) {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return;
  try {
    await consumePersonalAttempts(kind, userId, consumeMutationRateLimit);
  } catch (error) {
    if (error instanceof PersonalBudgetError) throw error;
    throw new PersonalBudgetError(503);
  }
}
