import type { RateDecision, RateRule } from "./guard-store";
import { consumeAuthRateLimit } from "./guard-client";

type Consume = (key: string, rule: RateRule) => Promise<RateDecision>;

/** Counters are consumed atomically by AuthGuard, shared across Worker isolates.
 * Failed delivery attempts consume budget too. Never refund by racing other sends. */
export async function consumeEmailBudget(to: string, consume: Consume) {
  const recipient = to.trim().toLowerCase();
  const rules: [string, RateRule][] = [
    [`mail:recipient:minute:${recipient}`, { window: 60, max: 1 }],
    [`mail:recipient:hour:${recipient}`, { window: 3600, max: 10 }],
    ["mail:global:minute", { window: 60, max: 120 }],
    ["mail:global:hour", { window: 3600, max: 1000 }],
  ];
  for (const [key, rule] of rules) if (!(await consume(key, rule)).allowed) return false;
  return true;
}

export async function reserveEmailDelivery(to: string) {
  // Hosted production runs on Workers. Local Node development has no DO binding;
  // a Node deployment must provide a shared limiter before opening registration.
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return true;
  // consumeAuthRateLimit HMACs keys before sending them to durable storage.
  // Missing binding / unavailable guard throws: never send without a reservation.
  return consumeEmailBudget(to, consumeAuthRateLimit);
}
