import { budgetShard } from "./worker-budget";
import { consumeMutationRateLimit, consumeMutationRateLimitPair } from "@/lib/auth/guard-client";
import type { RateCheck, RateDecision, RateRule } from "@/lib/auth/guard-store";
import { PublicActionError } from "./public-error";

export const PERSONAL_ATTEMPTS = {
  "feedback-submit": { minute: 5, hour: 20 },
  "privacy-reauth": { minute: 5, hour: 20 },
  "privacy-export": { minute: 2, hour: 10 },
  "privacy-delete": { minute: 3, hour: 10 },
  "privacy-consent": { minute: 120, hour: 3600 },
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
  constructor(
    public status: 429 | 503,
    options?: ErrorOptions,
  ) {
    super(
      status === 429
        ? "Too many account requests. Try again shortly."
        : "Account requests are temporarily unavailable. Try again.",
      options,
    );
  }
}
export async function consumePersonalAttempts(
  kind: PersonalOperation,
  userId: string,
  consume: (scope: string, key: string, rule: RateRule) => Promise<RateDecision>,
  consumePair?: (scope: string, first: RateCheck, second: RateCheck) => Promise<RateDecision>,
) {
  const limits = PERSONAL_ATTEMPTS[kind];
  // Anonymous identities must not allocate one persistent object per source IP.
  const anonymous = kind === "privacy-consent";
  const scope = anonymous
    ? `personal-consent-shard:${await budgetShard(userId)}`
    : `personal-${kind}:${userId}`;
  const checks: [RateCheck, RateCheck] = [
    { key: anonymous ? `${userId}:minute` : "minute", rule: { window: 60, max: limits.minute } },
    { key: anonymous ? `${userId}:hour` : "hour", rule: { window: 3600, max: limits.hour } },
  ];
  if (consumePair) {
    if (!(await consumePair(scope, ...checks)).allowed) throw new PersonalBudgetError(429);
    return;
  }
  for (const { key, rule } of checks) {
    if (!(await consume(scope, key, rule)).allowed) throw new PersonalBudgetError(429);
  }
}
export async function reservePersonalAttempts(kind: PersonalOperation, userId: string) {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return;
  try {
    await consumePersonalAttempts(
      kind,
      userId,
      consumeMutationRateLimit,
      consumeMutationRateLimitPair,
    );
  } catch (error) {
    if (error instanceof PersonalBudgetError) throw error;
    // Keep the cause in memory so the server reporter can classify it. Its
    // allowlist still excludes raw messages, identities and provider payloads.
    throw new PersonalBudgetError(503, { cause: error });
  }
}
