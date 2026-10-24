import { getCloudflareContext } from "@opennextjs/cloudflare";
/** Worker runtime switches override build-time/default environment values. */
export function analyticsSetting(
  name:
    | "DESKTOP_ANALYTICS_ENABLED"
    | "DESKTOP_ANALYTICS_STORAGE_ENABLED"
    | "DESKTOP_ANALYTICS_POSTHOG_AGGREGATES",
) {
  try {
    const env = getCloudflareContext().env as unknown as Record<string, unknown>;
    if (typeof env[name] === "string") return env[name];
  } catch {
    /* Node development and disposable database tests. */
  }
  return process.env[name];
}
