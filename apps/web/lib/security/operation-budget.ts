import { consumeMutationRateLimitPair } from "../auth/guard-client";
import { PublicActionError } from "./public-error";
import { budgetShard, windowChecks, type BudgetConsumer } from "./worker-budget";
import { admissionResponse } from "./ingress-budget";

// Request budgets run before body parsing; service budgets span browser/MCP
// transports. Separate keys prevent composed requests charging the same counter twice.
export const OPERATION_LIMITS = {
  "document-read": [240, 12_000, 1200, 60_000],
  "document-write": [240, 10_000, 1200, 50_000],
  "document-request": [240, 10_000, 1200, 50_000],
  "history-read": [120, 6000, 600, 30_000],
  "history-write": [5, 30, 10, 100],
  "history-request": [5, 30, 10, 100],
  "asset-upload": [120, 1000, 600, 5000],
  "asset-request": [120, 1000, 600, 5000],
  "avatar-read": [240, 6000, 1200, 30_000],
  "avatar-write": [10, 50, 30, 200],
  "avatar-request": [10, 50, 30, 200],
  import: [5, 30, 20, 100],
  "import-request": [5, 30, 20, 100],
  "extension-read": [60, 1200, 300, 6000],
  billing: [5, 20, 10, 40],
  "billing-request": [5, 20, 10, 40],
  "billing-reconcile": [2, 24, 2, 24],
  "presence-ticket": [30, 300, 120, 1000],
  "agent-read": [120, 6000, 600, 30_000],
  "mcp-request": [120, 6000, 600, 30_000],
} as const;
export type OperationKind = keyof typeof OPERATION_LIMITS;
export class OperationBudgetError extends PublicActionError {
  constructor(
    readonly status: 429 | 503,
    readonly retryAfter: number,
    options?: ErrorOptions,
  ) {
    super(
      status === 429
        ? "Too many requests. Try again shortly."
        : "Temporarily unavailable. Try again shortly.",
      options,
    );
  }
}
export async function consumeOperationBudget(
  kind: OperationKind,
  userId: string,
  organizationId: string | undefined,
  consume: BudgetConsumer,
) {
  const [accountMinute, accountHour, workspaceMinute, workspaceHour] = OPERATION_LIMITS[kind];
  const checks = [
    [`account:${userId}`, accountMinute, accountHour],
    ...(organizationId
      ? [[`workspace:${organizationId}`, workspaceMinute, workspaceHour] as const]
      : []),
  ] as const;
  for (const [identity, minute, hour] of checks) {
    const decision = await consume(
      `operations:${kind}:${await budgetShard(identity)}`,
      ...windowChecks(identity, minute, hour),
    );
    if (!decision.allowed) throw new OperationBudgetError(429, decision.retryAfter ?? 60);
  }
}
export async function reserveOperation(
  kind: OperationKind,
  userId: string,
  organizationId?: string,
) {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return;
  try {
    await consumeOperationBudget(kind, userId, organizationId, consumeMutationRateLimitPair);
  } catch (error) {
    if (error instanceof OperationBudgetError) throw error;
    throw new OperationBudgetError(503, 5, { cause: error });
  }
}
export function operationFailure(error: unknown): Response | null {
  return error instanceof OperationBudgetError
    ? admissionResponse(error.status, error.retryAfter)
    : null;
}
/** For route handlers without a shared domain error boundary. */
export async function operationBudgetResponse(
  kind: OperationKind,
  userId: string,
  organizationId?: string,
) {
  try {
    await reserveOperation(kind, userId, organizationId);
    return null;
  } catch (error) {
    const response = operationFailure(error);
    if (response) return response;
    throw error;
  }
}

/** Call only after resolving and authorizing the actual resource workspace. */
export async function reserveWorkspaceOperation(kind: OperationKind, organizationId: string) {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return;
  const [, , minute, hour] = OPERATION_LIMITS[kind];
  const identity = `workspace:${organizationId}`;
  try {
    const decision = await consumeMutationRateLimitPair(
      `operations:${kind}:${await budgetShard(identity)}`,
      ...windowChecks(identity, minute, hour),
    );
    if (!decision.allowed) throw new OperationBudgetError(429, decision.retryAfter ?? 60);
  } catch (error) {
    if (error instanceof OperationBudgetError) throw error;
    throw new OperationBudgetError(503, 5, { cause: error });
  }
}
