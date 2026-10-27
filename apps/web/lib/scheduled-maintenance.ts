type Environment = Pick<CloudflareEnv, "WORKER_SELF_REFERENCE"> & {
  PRIVACY_CLEANUP_SECRET?: string;
  BILLING_RECONCILIATION_SECRET?: string;
  DESKTOP_ANALYTICS_STORAGE_ENABLED?: string;
};

export async function runScheduledMaintenance(env: Environment) {
  const jobs = [
    { path: "/api/privacy/cleanup", secret: env.PRIVACY_CLEANUP_SECRET, required: true },
    {
      path: "/api/internal/billing/reconcile",
      secret: env.BILLING_RECONCILIATION_SECRET,
      required: false,
    },
  ];
  if (env.DESKTOP_ANALYTICS_STORAGE_ENABLED === "1")
    jobs.push({
      path: "/api/internal/analytics/maintenance",
      secret: env.PRIVACY_CLEANUP_SECRET,
      required: true,
    });
  const results = await Promise.allSettled(
    jobs.map(async ({ path, secret, required }) => {
      if (!required && !secret) return;
      if (!secret || secret.length < 32 || !env.WORKER_SELF_REFERENCE)
        throw new Error("Scheduled maintenance configuration is incomplete.");
      const request = new Request(`https://maintenance.internal${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
      });
      // Let the route finish its own deadline and return a bounded response
      // before the outer scheduled request expires.
      const response = await env.WORKER_SELF_REFERENCE.fetch(
        new Request(request, {
          signal: AbortSignal.timeout(requestDeadline(request) + 5000),
        }),
      );
      await response.body?.cancel();
      if (!response.ok) throw new Error("Scheduled maintenance did not complete.");
    }),
  );
  if (results.some((result) => result.status === "rejected"))
    throw new Error("Scheduled maintenance did not complete.");
}
import { requestDeadline } from "./request-boundary";
