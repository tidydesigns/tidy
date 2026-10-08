import { consumeMutationRateLimit } from "@/lib/auth/guard-client";
import type { RateDecision, RateRule } from "@/lib/auth/guard-store";
import { MutationBudgetError } from "@/lib/security/mutation-budget";
import { IMAGE_OPERATION_LIMITS } from "@/lib/security/resource-limits";
import { ImageCapacityError } from "./image-capacity";

type Kind = "read" | "thumbnail";
export class ImageBudgetUnavailableError extends Error {
  constructor() {
    super("Images are temporarily unavailable. Try again shortly.");
  }
}

/** Account counters span workspaces; workspace counters span actors. No refunds. */
export async function consumeImageBudget(
  kind: Kind,
  userId: string,
  organizationId: string,
  consume: (scope: string, key: string, rule: RateRule) => Promise<RateDecision>,
) {
  const limits = IMAGE_OPERATION_LIMITS[kind];
  for (const [scope, key, rule] of [
    [`image-${kind}-account:${userId}`, "minute", { window: 60, max: limits.accountMinute }],
    [`image-${kind}-account:${userId}`, "hour", { window: 3600, max: limits.accountHour }],
    [
      `image-${kind}-workspace:${organizationId}`,
      "minute",
      { window: 60, max: limits.workspaceMinute },
    ],
    [
      `image-${kind}-workspace:${organizationId}`,
      "hour",
      { window: 3600, max: limits.workspaceHour },
    ],
  ] as const) {
    const decision = await consume(scope, key, rule);
    if (!decision.allowed) throw new MutationBudgetError(decision.retryAfter ?? 60);
  }
}
export async function reserveImageOperation(kind: Kind, userId: string, organizationId: string) {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return;
  try {
    await consumeImageBudget(kind, userId, organizationId, consumeMutationRateLimit);
  } catch (error) {
    if (error instanceof MutationBudgetError) throw error;
    throw new ImageBudgetUnavailableError();
  }
}

export function imageFailureResponse(error: unknown) {
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
