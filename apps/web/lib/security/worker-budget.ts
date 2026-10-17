import type { RateCheck, RateDecision, RateRule } from "../auth/guard-store";
import { waitForSignal } from "../request-lifecycle";

export type BudgetConsumer = (
  scope: string,
  first: RateCheck,
  second: RateCheck,
) => Promise<RateDecision>;
export type BudgetEnvironment = Pick<CloudflareEnv, "AUTH_GUARD" | "BETTER_AUTH_SECRET">;

/** Works before OpenNext installs its request context. No raw identities in DO
 * names/storage and no pending RPCs shared between Worker invocations. */
export function workerBudgetConsumer(env: BudgetEnvironment, parent?: AbortSignal): BudgetConsumer {
  return async (scope, first, second) => {
    const signal = AbortSignal.any([AbortSignal.timeout(2000), ...(parent ? [parent] : [])]);
    if (!env.AUTH_GUARD || !env.BETTER_AUTH_SECRET) throw new Error("Missing admission bindings.");
    const secret = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.BETTER_AUTH_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const fingerprint = async (key: string) => {
      const digest = await crypto.subtle.sign("HMAC", secret, new TextEncoder().encode(key));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const guard = env.AUTH_GUARD.getByName(`admission-v1:${scope}`);
    const key = await fingerprint(first.key);
    const next = { key: await fingerprint(second.key), rule: second.rule };
    signal.throwIfAborted();
    const decision = await waitForSignal(guard.consume(key, first.rule, next), signal);
    if (!decision.allowed || ("batchSupported" in decision && decision.batchSupported === true))
      return decision;
    signal.throwIfAborted();
    return waitForSignal(guard.consume(next.key, next.rule), signal);
  };
}

/** Fixed shard count bounds storage even when identities are attacker chosen. */
export async function budgetShard(identity: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return new Uint8Array(digest)[0] % 64;
}

export function windowChecks(
  key: string,
  minute: number,
  hour: number,
  cost = 1,
): [RateCheck, RateCheck] {
  const rule = (window: number, max: number): RateRule => ({ window, max, cost });
  return [
    { key: `${key}:minute`, rule: rule(60, minute) },
    { key: `${key}:hour`, rule: rule(3600, hour) },
  ];
}
