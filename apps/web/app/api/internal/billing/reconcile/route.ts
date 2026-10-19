import { timingSafeEqual } from "node:crypto";
import { reconcileBilling } from "@/lib/billing/reconciliation";
import { operationBudgetResponse } from "@/lib/security/operation-budget";

export async function POST(request: Request) {
  const secret = process.env.BILLING_RECONCILIATION_SECRET;
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  const headers = { "Cache-Control": "private, no-store" };
  if (
    !secret ||
    secret.length < 32 ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return new Response(null, { status: 401, headers });
  const denied = await operationBudgetResponse("billing-reconcile", "scheduled");
  if (denied) return denied;
  const result = await reconcileBilling();
  return Response.json(result, { status: result.failed ? 503 : 200, headers });
}
