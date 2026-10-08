import { withRequestBodyLimit } from "@/lib/http/request-body";
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
  let organizationId: unknown;
  try {
    organizationId = ((await request.json()) as { organizationId?: unknown }).organizationId;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof organizationId !== "string" || !organizationId)
    return new Response(null, { status: 400 });
  try {
    return Response.json({ url: await portalUrl(session.user.id, organizationId) });
  } catch (error) {
    console.error("Stripe portal failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not open billing." },
      { status: 400 },
    );
  }
}

export const POST = withRequestBodyLimit(post);
