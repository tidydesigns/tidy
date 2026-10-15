import { consumeMutationRateLimitPair } from "@/lib/auth/guard-client";
import type { RateCheck, RateDecision } from "@/lib/auth/guard-store";

export class PublicBudgetError extends Error {
  constructor(readonly retryAfter: number) {
    super("Public endpoint budget exhausted.");
  }
}

type Consume = (scope: string, first: RateCheck, second: RateCheck) => Promise<RateDecision>;
const hosted = () =>
  typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

/** Keep earlier charges when a later window or identity check denies admission. */
async function reserve(
  scope: string,
  minute: number,
  hour: number,
  cost: number,
  consume: Consume,
  identity?: string,
) {
  const prefix = identity === undefined ? "" : `${identity}:`;
  const result = await consume(
    scope,
    { key: `${prefix}minute`, rule: { window: 60, max: minute, cost } },
    { key: `${prefix}hour`, rule: { window: 3600, max: hour, cost } },
  );
  if (!result.allowed) throw new PublicBudgetError(result.retryAfter ?? 60);
}

/** Fixed routing bounds telemetry to 64 IP and 64 receipt objects, each with
 * AuthGuardStore's 10,000-row cap. Idle shards cannot accumulate unbounded state;
 * expired counters are reclaimed on reuse. Keys are HMACed by the guard client. */
async function identityScope(kind: "ip" | "receipt", identity: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return `telemetry-${kind}-shard:${new Uint8Array(digest)[0]! % 64}`;
}

/** Charge attempts before session/database work. IPs are HMACed by the guard client.
 * A generous IP allowance accommodates offices and multiple browser tabs.
 * Public traffic has its own shards, independent of login and privacy choices. */
export async function reserveTelemetryAttempt(request: Request) {
  if (!hosted()) return;
  await consumeTelemetryAttempt(
    request.headers.get("cf-connecting-ip") || "unknown",
    consumeMutationRateLimitPair,
  );
}
/** Reject global exhaustion before allocating any IP counter state. */
export async function consumeTelemetryAttempt(ip: string, consume: Consume) {
  await reserve("telemetry-attempts", 12_000, 500_000, 1, consume);
  await reserve(await identityScope("ip", ip), 600, 10_000, 1, consume, ip);
}

/** Charge actual received bytes, never Content-Length. A minimum charge also
 * bounds tiny requests/GETs. One receipt spans tabs; global limits span receipts.
 * Failed provider deliveries retain their charge. */
export async function reserveTelemetryBytes(receipt: string, bytes: number) {
  if (!hosted()) return;
  await consumeTelemetryBytes(receipt, bytes, consumeMutationRateLimitPair);
}
/** Charge shared capacity first, including attempts later denied per receipt. */
export async function consumeTelemetryBytes(receipt: string, bytes: number, consume: Consume) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 5_000_000)
    throw new PublicBudgetError(60);
  const cost = Math.max(65_536, bytes);
  await reserve("telemetry-bytes", 500_000_000, 5_000_000_000, cost, consume);
  await reserve(
    await identityScope("receipt", receipt),
    20_000_000,
    200_000_000,
    cost,
    consume,
    receipt,
  );
}

/** Bounds cold/cache-miss readiness queries across isolates and locations. */
export async function reserveHealthCheck() {
  if (!hosted()) return;
  await reserve("public-health", 120, 7200, 1, consumeMutationRateLimitPair);
}
