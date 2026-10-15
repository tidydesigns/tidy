import "server-only";
import { cache } from "react";
import { featureFlagKeys, FLAGS_OFF, type FunctionalFlags } from "./feature-flags";

type Configuration = { key?: string; host?: string };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Evaluate global rollout switches without user identity, cookies or event capture. */
export async function evaluateFunctionalFlags({
  key,
  host,
}: Configuration): Promise<FunctionalFlags> {
  if (!key || !host) return FLAGS_OFF;
  try {
    const url = new URL(host);
    if (
      url.protocol !== "https:" ||
      !["eu.i.posthog.com", "us.i.posthog.com", "t.tidydesign.co"].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    )
      return FLAGS_OFF;
    url.pathname = "/flags/";
    url.search = "?v=2";
    url.hash = "";
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        // One fixed service marker for every request, never an account/device ID.
        distinct_id: "tidy-functional-rollout",
        flag_keys_to_evaluate: featureFlagKeys,
      }),
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return FLAGS_OFF;
    }
    const data = object(await response.json());
    if (
      data.errorsWhileComputingFlags !== false ||
      data.error ||
      (Array.isArray(data.quotaLimited) && data.quotaLimited.includes("feature_flags"))
    )
      return FLAGS_OFF;
    const results = object(data.flags);
    return Object.fromEntries(
      featureFlagKeys.map((key) => {
        const flag = object(results[key]);
        return [
          key,
          flag.enabled === true &&
            flag.failed !== true &&
            (flag.variant === undefined || flag.variant === null),
        ];
      }),
    ) as FunctionalFlags;
  } catch {
    // No stale enabled fallback on network, timeout, JSON or provider failures.
    return FLAGS_OFF;
  }
}

// React's cache lasts only for this render/request. Never share pending I/O
// across Cloudflare Worker requests, or retain enabled values after failures.
export const functionalFeatureFlags = cache(() =>
  evaluateFunctionalFlags({
    key: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  }),
);
