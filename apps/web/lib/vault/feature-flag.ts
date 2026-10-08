import "server-only";
import { cache } from "react";
import { PostHog } from "posthog-node";

type FlagRuntime = { key?: string; host?: string };

// React deduplicates the page and navigation checks within a render. Never
// share a PostHog client or pending I/O between Cloudflare Worker requests.
export const vaultEnabled = cache(
  async (userId: string, runtime?: FlagRuntime): Promise<boolean> => {
    if (process.env.NODE_ENV === "test" && !runtime?.key) return false;
    const key = runtime?.key ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const host = runtime?.host ?? process.env.NEXT_PUBLIC_POSTHOG_HOST;
    if (!key || !host) return false;

    const client = new PostHog(key, {
      host,
      flushAt: 1,
      flushInterval: 0,
      fetchRetryCount: 0,
      requestTimeout: 2000,
      featureFlagsRequestTimeoutMs: 2000,
      disableGeoip: true,
      enableExceptionAutocapture: false,
    });
    client.on("error", () => {});
    try {
      const flags = await client.evaluateFlags(userId, { flagKeys: ["vault"] });
      return flags.getFlag("vault") === true;
    } catch {
      return false;
    } finally {
      await client.shutdown(2000).catch(() => {});
    }
  },
);
