import { reportHandledError } from "@/lib/handled-error";
import { consumeMutationRateLimit, consumeMutationRateLimitPair } from "@/lib/auth/guard-client";
import type { RateCheck, RateDecision, RateRule } from "@/lib/auth/guard-store";
import { MutationBudgetError } from "@/lib/security/mutation-budget";
import { IMAGE_OPERATION_LIMITS } from "@/lib/security/resource-limits";
import { safeErrorCode, traceDetails, traceOperation, traceStorage } from "@/lib/trace-context";
import { ImageCapacityError } from "./image-capacity";

type Kind = "read" | "thumbnail";
export class ImageBudgetUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Images are temporarily unavailable. Try again shortly.", { cause });
  }
}

/** Account counters span workspaces; workspace counters span actors. No refunds. */
export async function consumeImageBudget(
  kind: Kind,
  userId: string,
  organizationId: string,
  consume: (scope: string, key: string, rule: RateRule) => Promise<RateDecision>,
  consumePair?: (scope: string, first: RateCheck, second: RateCheck) => Promise<RateDecision>,
) {
  const limits = IMAGE_OPERATION_LIMITS[kind];
  for (const [scope, minuteMax, hourMax] of [
    [`image-${kind}-account:${userId}`, limits.accountMinute, limits.accountHour],
    [`image-${kind}-workspace:${organizationId}`, limits.workspaceMinute, limits.workspaceHour],
  ] as const) {
    const minute = { key: "minute", rule: { window: 60, max: minuteMax } };
    const hour = { key: "hour", rule: { window: 3600, max: hourMax } };
    let decision: RateDecision;
    if (consumePair) decision = await consumePair(scope, minute, hour);
    else {
      decision = await consume(scope, minute.key, minute.rule);
      if (decision.allowed) decision = await consume(scope, hour.key, hour.rule);
    }
    if (!decision.allowed) throw new MutationBudgetError(decision.retryAfter ?? 60);
  }
}
export async function reserveImageOperation(kind: Kind, userId: string, organizationId: string) {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return;
  try {
    await traceOperation("image.budget", () =>
      consumeImageBudget(
        kind,
        userId,
        organizationId,
        consumeMutationRateLimit,
        consumeMutationRateLimitPair,
      ),
    );
  } catch (error) {
    if (error instanceof MutationBudgetError) throw error;
    throw new ImageBudgetUnavailableError(error);
  }
}

export function imageFailureResponse(error: unknown) {
  if (!(error instanceof MutationBudgetError || error instanceof ImageCapacityError))
    reportHandledError(error);
  const reason =
    error instanceof MutationBudgetError
      ? "rate_limit"
      : error instanceof ImageCapacityError
        ? "capacity"
        : error instanceof ImageBudgetUnavailableError
          ? "budget_unavailable"
          : "unexpected_error";
  const code = safeErrorCode(error instanceof ImageBudgetUnavailableError ? error.cause : error);
  const root = traceStorage.getStore()?.trace.root;
  root?.setAttribute("image.failure_reason", reason);
  if (code) root?.setAttribute("error.code", code);
  console.warn(JSON.stringify({ event: "image_failed", reason, code, ...traceDetails() }));
  const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
  if (error instanceof MutationBudgetError) {
    headers["Retry-After"] = String(error.retryAfter);
    return Response.json({ error: error.message }, { status: 429, headers });
  }
  if (error instanceof ImageCapacityError) headers["Retry-After"] = "1";
  return Response.json(
    { error: "Images are temporarily unavailable. Try again shortly." },
    { status: 503, headers },
  );
}
