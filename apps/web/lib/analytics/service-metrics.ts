import "server-only";
import { after } from "next/server";
import { db } from "@/lib/db";
import { runWithRequestSignal } from "@/lib/request-lifecycle";
import { sampleDiagnostics } from "@/lib/diagnostic-sampling";
import {
  observeDesktopService,
  serviceMetricSchema,
  type ServiceMetric,
} from "@/lib/desktop/service-observability";
import { analyticsSetting } from "./config";

export const desktopServiceMetricsEnabled = () =>
  analyticsSetting("DESKTOP_ANALYTICS_STORAGE_ENABLED") === "1" &&
  analyticsSetting("DESKTOP_SERVICE_METRICS_ENABLED") !== "0";

/** Fixed server-owned 10% sampling, shared by all outcomes; counts are observations, not people. */
export async function recordDesktopServiceMetric(input: ServiceMetric) {
  if (!desktopServiceMetricsEnabled()) return;
  const metric = serviceMetricSchema.parse(input);
  await db.query(
    `insert into "desktopServiceMetric" (day,operation,outcome,latency,samples)
    values ($1,$2,$3,$4,1)
    on conflict(day,operation,outcome,latency) do update
    set samples="desktopServiceMetric".samples+1`,
    [metric.day, metric.operation, metric.outcome, metric.latency],
  );
}

/** No new client requests, endpoint storage/access, identifiers, account linking or PostHog export. */
export function withDesktopServiceMetrics(request: Request, handle: () => Promise<Response>) {
  if (!desktopServiceMetricsEnabled() || !sampleDiagnostics(0.1)) return handle();
  return observeDesktopService(request, handle, (metric) => {
    after(async () => {
      try {
        // Reporting has its own short lifetime after the functional response completes.
        await runWithRequestSignal(AbortSignal.timeout(1500), () =>
          recordDesktopServiceMetric(metric),
        );
      } catch {
        console.warn(JSON.stringify({ event: "desktop_service_metric_unavailable" }));
      }
    });
  });
}
