import { actionError } from "@/lib/action-error";
import { operationBudgetResponse, operationFailure } from "@/lib/security/operation-budget";
import { boundedRequest, RequestBodyError, requestBodyError } from "@/lib/http/request-body";
import { auth } from "@/lib/auth";
import { portalUrl } from "@/lib/billing/server";

export const runtime = "nodejs";

async function post(request: Request) {
  if (
    request.headers.get("origin") !==
    new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").origin
  )
    return new Response(null, { status: 403 });
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return new Response(null, { status: 415 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });
  const denied = await operationBudgetResponse("billing-request", session.user.id);
  if (denied) return denied;
  let organizationId: unknown;
  try {
    organizationId = (
      (await (await boundedRequest(request)).json()) as { organizationId?: unknown }
    ).organizationId;
  } catch (error) {
    if (error instanceof RequestBodyError) return requestBodyError(error);
    return new Response(null, { status: 400 });
  }
  if (typeof organizationId !== "string" || !organizationId)
    return new Response(null, { status: 400 });
  try {
    return Response.json({ url: await portalUrl(session.user.id, organizationId) });
  } catch (error) {
    const denied = operationFailure(error);
    if (denied) return denied;
    console.error("Stripe portal failed", error);
    return Response.json({ error: actionError(error, "Could not open billing.") }, { status: 400 });
  }
}

export const POST = post;
