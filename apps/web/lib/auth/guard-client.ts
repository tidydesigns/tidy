import { getCloudflareContext } from "@opennextjs/cloudflare";
import { traceAuthOperation, requestSignal, waitForSignal } from "./request-lifecycle";
import type { RateCheck, RateRule } from "./guard-store";
import { authRateLimitKey } from "./rate-limit-key";

export function authGuard() {
  const { env } = getCloudflareContext();
  if (!env.AUTH_GUARD) throw new Error("AUTH_GUARD binding is required for Worker authentication.");
  return env.AUTH_GUARD.get(env.AUTH_GUARD.idFromName("mcp-auth-v1"));
}

export function consumeAuthRateLimit(key: string, rule: RateRule) {
  return consumeRateLimit(key, rule);
}

export async function consumeAuthEndpointRateLimit(key: string, rule: RateRule) {
  const counter = await authRateLimitKey(key, rule);
  return consumeRateLimit(counter.key, rule, counter.scope);
}

/** Separate tenant shards keep application traffic from exhausting authentication counters. */
export function consumeMutationRateLimit(organizationId: string, key: string, rule: RateRule) {
  return consumeRateLimit(key, rule, `application-mutations-v1:${organizationId}`);
}

/** One RPC per account/workspace on upgraded guards. A legacy guard ignores the
 * third argument; only an acknowledged successful first check permits fallback.
 * Never replay a call after a timeout or another ambiguous transport failure. */
export function consumeMutationRateLimitPair(scope: string, first: RateCheck, second: RateCheck) {
  return traceAuthOperation("rate_limit", async () => {
    const { guard, fingerprint } = await rateLimitContext(`application-mutations-v1:${scope}`);
    const key = await fingerprint(first.key);
    const next = { key: await fingerprint(second.key), rule: second.rule };
    const signal = rateLimitSignal();
    signal.throwIfAborted();
    const decision = await waitForSignal(guard.consume(key, first.rule, next), signal);
    if (!decision.allowed || ("batchSupported" in decision && decision.batchSupported === true))
      return decision;
    const fallbackSignal = rateLimitSignal();
    fallbackSignal.throwIfAborted();
    return waitForSignal(guard.consume(next.key, next.rule), fallbackSignal);
  });
}

async function consumeRateLimit(key: string, rule: RateRule, scope?: string) {
  return traceAuthOperation("rate_limit", async () => {
    const { guard, fingerprint } = await rateLimitContext(scope);
    const name = await fingerprint(key);
    const signal = rateLimitSignal();
    signal.throwIfAborted();
    return waitForSignal(guard.consume(name, rule), signal);
  });
}

function rateLimitSignal() {
  const parent = requestSignal();
  return AbortSignal.any([AbortSignal.timeout(2000), ...(parent ? [parent] : [])]);
}

async function rateLimitContext(scope?: string) {
  const { env } = getCloudflareContext();
  // Rate-limit keys can contain client IPs; never store their original form.
  const secret = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const fingerprint = async (value: string) => {
    const digest = await crypto.subtle.sign("HMAC", secret, new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  let guard = authGuard();
  if (scope) {
    const name = await fingerprint(scope);
    guard = env.AUTH_GUARD.get(env.AUTH_GUARD.idFromName(`mutations:${name}`));
  }
  return { guard, fingerprint };
}
