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

async function reserve(
  scope: string,
  minute: number,
  hour: number,
  cost: number,
  consume: Consume,
) {
  const result = await consume(
    scope,
    { key: "minute", rule: { window: 60, max: minute, cost } },
    { key: "hour", rule: { window: 3600, max: hour, cost } },
  );
  if (!result.allowed) throw new PublicBudgetError(result.retryAfter ?? 60);
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
export async function consumeTelemetryAttempt(ip: string, consume: Consume) {
  await reserve(`telemetry-ip:${ip}`, 600, 10_000, 1, consume);
  await reserve("telemetry-attempts", 12_000, 500_000, 1, consume);
}

/** Charge actual received bytes, never Content-Length. A minimum charge also
 * bounds tiny requests/GETs. One receipt spans tabs; global limits span receipts.
 * Failed provider deliveries retain their charge. */
export async function reserveTelemetryBytes(receipt: string, bytes: number) {
  if (!hosted()) return;
  await consumeTelemetryBytes(receipt, bytes, consumeMutationRateLimitPair);
}
export async function consumeTelemetryBytes(receipt: string, bytes: number, consume: Consume) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 5_000_000)
    throw new PublicBudgetError(60);
  const cost = Math.max(65_536, bytes);
  await reserve(`telemetry-receipt:${receipt}`, 20_000_000, 200_000_000, cost, consume);
  await reserve("telemetry-bytes", 500_000_000, 5_000_000_000, cost, consume);
}

/** Bounds cold/cache-miss readiness queries across isolates and locations. */
export async function reserveHealthCheck() {
  if (!hosted()) return;
  await reserve("public-health", 120, 7200, 1, consumeMutationRateLimitPair);
}
