import { budgetShard } from "../security/worker-budget";
import type { RateRule } from "./guard-store";

// Keep endpoint counters separate only where authentication has an explicit
// rule. All other paths share the default allowance, including unknown paths.
const endpoints = new Set([
  "/sign-in/email",
  "/sign-up/email",
  "/request-password-reset",
  "/send-verification-email",
  "/sign-in/social",
  "/oauth2/register",
  "/oauth2/authorize",
  "/oauth2/token",
]);

export async function authRateLimitKey(key: string, rule: RateRule) {
  const separator = key.indexOf("|");
  if (separator < 1) throw new Error("Invalid authentication counter.");
  const identity = key.slice(0, separator);
  const path = key.slice(separator + 1);
  return {
    scope: `auth-endpoints-v2:${await budgetShard(identity)}`,
    key: `${identity}|${endpoints.has(path) ? path : `other:${rule.window}:${rule.max}`}`,
  };
}
