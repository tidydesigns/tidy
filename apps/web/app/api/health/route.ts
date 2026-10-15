import { getCloudflareContext } from "@opennextjs/cloudflare";
import { checkDatabaseHealth } from "@/lib/database-health";
import { healthResponse } from "@/lib/health-response";
import { reserveHealthCheck } from "@/lib/security/public-budget";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const hosted = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
  // Scope by canonical deployment origin and release, never attacker query strings.
  const version = hosted ? getCloudflareContext().env.CF_VERSION_METADATA.id : "local";
  const key = new Request(
    new URL(
      `/api/health?release=${encodeURIComponent(version)}`,
      process.env.BETTER_AUTH_URL || request.url,
    ),
  );
  return healthResponse(
    key,
    checkDatabaseHealth,
    reserveHealthCheck,
    hosted ? await caches.open("tidy-readiness-v1").catch(() => undefined) : undefined,
  );
}
