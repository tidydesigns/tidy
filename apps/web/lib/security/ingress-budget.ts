import {
  budgetShard,
  windowChecks,
  workerBudgetConsumer,
  type BudgetConsumer,
  type BudgetEnvironment,
} from "./worker-budget";

// These are shared admission ceilings, not monthly spend guarantees. Separate
// essential paths so optional traffic cannot consume authentication/erasure capacity.
export const INGRESS_LIMITS = {
  application: { minute: 20_000, hour: 500_000, ipMinute: 2400, ipHour: 60_000 },
  auth: { minute: 2000, hour: 30_000, ipMinute: 120, ipHour: 6000 },
  registration: { minute: 60, hour: 1000, ipMinute: 5, ipHour: 20 },
  privacy: { minute: 1200, hour: 36_000, ipMinute: 120, ipHour: 3600 },
  webhook: { minute: 600, hour: 10_000, ipMinute: 300, ipHour: 5000 },
  cleanup: { minute: 60, hour: 1000, ipMinute: 10, ipHour: 120 },
} as const;
export function ingressKind(request: Request): keyof typeof INGRESS_LIMITS | null {
  let path: string;
  try {
    path = decodeURIComponent(new URL(request.url).pathname).replace(/\/+$/, "") || "/";
  } catch {
    return "application";
  }
  // These endpoints already have independent global pre-database budgets.
  if (path === "/api/health" || path === "/api/t" || path.startsWith("/api/t/")) return null;
  if (path === "/api/privacy/cleanup" || path === "/api/internal/billing/reconcile")
    return "cleanup";
  if (path.startsWith("/api/privacy/")) return "privacy";
  if (/^\/api\/(billing|github|linear)\/webhook$/.test(path)) return "webhook";
  if (path === "/api/auth/sign-up/email") return "registration";
  if (
    path.startsWith("/api/auth/") ||
    path.startsWith("/.well-known/") ||
    ["/login", "/sign-up", "/forgot-password", "/reset-password", "/mcp/consent"].includes(path)
  )
    return "auth";
  return "application";
}
export function admissionResponse(status: 429 | 503, retryAfter: number) {
  return Response.json(
    {
      error:
        status === 429
          ? "Too many requests. Try again shortly."
          : "Temporarily unavailable. Try again shortly.",
    },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store",
        "Retry-After": String(retryAfter),
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
export async function checkIngress(
  request: Request,
  consume: BudgetConsumer,
): Promise<Response | null> {
  const kind = ingressKind(request);
  if (!kind) return null;
  const limits = INGRESS_LIMITS[kind];
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  try {
    const ipDecision = await consume(
      `ingress:${kind}:ip:${await budgetShard(ip)}`,
      ...windowChecks(ip, limits.ipMinute, limits.ipHour),
    );
    if (!ipDecision.allowed) return admissionResponse(429, ipDecision.retryAfter ?? 60);
    const decision = await consume(
      `ingress:${kind}`,
      ...windowChecks("global", limits.minute, limits.hour),
    );
    return decision.allowed ? null : admissionResponse(429, decision.retryAfter ?? 60);
  } catch {
    // Do not report admission failures to a billable telemetry provider.
    return admissionResponse(503, 5);
  }
}
export function ingressResponse(request: Request, env: BudgetEnvironment) {
  return checkIngress(request, workerBudgetConsumer(env, request.signal));
}
