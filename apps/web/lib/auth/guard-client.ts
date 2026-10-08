import { getCloudflareContext } from "@opennextjs/cloudflare";
import { traceAuthOperation, requestSignal, waitForSignal } from "./request-lifecycle";
import type { RateRule } from "./guard-store";

export function authGuard() {
  const { env } = getCloudflareContext();
  if (!env.AUTH_GUARD) throw new Error("AUTH_GUARD binding is required for Worker authentication.");
  return env.AUTH_GUARD.get(env.AUTH_GUARD.idFromName("mcp-auth-v1"));
}

export function consumeAuthRateLimit(key: string, rule: RateRule) {
  return consumeRateLimit(key, rule);
}

/** Separate tenant shards keep application traffic from exhausting authentication counters. */
export function consumeMutationRateLimit(organizationId: string, key: string, rule: RateRule) {
  return consumeRateLimit(key, rule, `application-mutations-v1:${organizationId}`);
}

async function consumeRateLimit(key: string, rule: RateRule, scope?: string) {
  return traceAuthOperation("rate_limit", async () => {
    const { env } = getCloudflareContext();
    // Rate-limit keys can contain client IPs; never store their original form.
    const secret = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.BETTER_AUTH_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign("HMAC", secret, new TextEncoder().encode(key));
    const fingerprint = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const parent = requestSignal();
    const signal = AbortSignal.any([AbortSignal.timeout(2000), ...(parent ? [parent] : [])]);
    let guard = authGuard();
    if (scope) {
      const scopeDigest = await crypto.subtle.sign("HMAC", secret, new TextEncoder().encode(scope));
      const name = [...new Uint8Array(scopeDigest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      guard = env.AUTH_GUARD.get(env.AUTH_GUARD.idFromName(`mutations:${name}`));
    }
    return waitForSignal(guard.consume(fingerprint, rule), signal);
  });
}
