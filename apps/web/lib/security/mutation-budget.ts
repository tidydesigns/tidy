import { PublicActionError } from "@/lib/security/public-error";
import { consumeMutationRateLimit } from "@/lib/auth/guard-client";
import type { RateDecision, RateRule } from "@/lib/auth/guard-store";

export class MutationBudgetError extends PublicActionError {
  constructor(readonly retryAfter: number) {
    super("Too many changes. Wait before trying again.");
  }
}
type Consume = (key: string, rule: RateRule) => Promise<RateDecision>;

/** Conservative reservations: failures and deletions do not refund consumed capacity. */
export async function consumeCommentBudget(userId: string, consume: Consume) {
  const rules: [string, RateRule][] = [
    [`comments:user:minute:${userId}`, { window: 60, max: 60 }],
    [`comments:user:hour:${userId}`, { window: 3600, max: 600 }],
    ["comments:workspace:minute", { window: 60, max: 300 }],
    ["comments:workspace:hour", { window: 3600, max: 3000 }],
  ];
  for (const [key, rule] of rules) {
    const result = await consume(key, rule);
    if (!result.allowed) throw new MutationBudgetError(result.retryAfter ?? 60);
  }
}

export async function reserveCommentMutation(userId: string, organizationId: string) {
  // This is the hosted Worker limiter. Other deployments need a shared adapter;
  // local Node fixtures still exercise transactional persistent-capacity limits.
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return;
  await consumeCommentBudget(userId, (key, rule) =>
    consumeMutationRateLimit(organizationId, key, rule),
  );
}

export async function consumeInvitationBudget(userId: string, consume: Consume) {
  const rules: [string, RateRule][] = [
    [`invitations:user:minute:${userId}`, { window: 60, max: 10 }],
    [`invitations:user:hour:${userId}`, { window: 3600, max: 100 }],
    ["invitations:workspace:minute", { window: 60, max: 30 }],
    ["invitations:workspace:hour", { window: 3600, max: 300 }],
  ];
  for (const [key, rule] of rules) {
    const result = await consume(key, rule);
    if (!result.allowed) throw new MutationBudgetError(result.retryAfter ?? 60);
  }
}

export async function reserveInvitationMutation(userId: string, organizationId: string) {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return;
  await consumeInvitationBudget(userId, (key, rule) =>
    consumeMutationRateLimit(organizationId, key, rule),
  );
}
