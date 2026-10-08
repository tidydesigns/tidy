import { APIError } from "better-auth/api";
import { consumeAuthRateLimit } from "./guard-client";
import type { RateDecision, RateRule } from "./guard-store";

export const OAUTH_CLIENT_LIMITS = {
  retained: 10_000,
  hourly: 1000,
  metadataBytes: 16_384,
} as const;

export async function consumeRegistrationBudget(
  consume: (key: string, rule: RateRule) => Promise<RateDecision>,
) {
  for (const [key, rule] of [
    ["oauth-registration:minute", { window: 60, max: 60 }],
    ["oauth-registration:hour", { window: 3600, max: OAUTH_CLIENT_LIMITS.hourly }],
  ] as const) {
    const result = await consume(key, rule);
    if (!result.allowed)
      throw new APIError("TOO_MANY_REQUESTS", {
        error: "temporarily_unavailable",
        error_description: "Client registration is busy. Try again later.",
      });
  }
}

export async function reserveClientRegistration() {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return;
  await consumeRegistrationBudget(consumeAuthRateLimit);
}
