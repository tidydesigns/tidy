import { auth } from "@/lib/auth";
import { boundedRequest, RequestBodyError, requestBodyError } from "@/lib/http/request-body";
import { MutationBudgetError } from "@/lib/security/mutation-budget";
import { planLimitMessage } from "@/lib/billing/plans";
import {
  transferClipboardAssets,
  ClipboardAccessError,
  ClipboardTransferError,
  ClipboardBudgetUnavailableError,
} from "@/lib/design/clipboard-assets";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: RouteContext<"/api/files/[uid]/clipboard-assets">,
) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return new Response(null, { status: 403 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });
  const { uid } = await params;
  try {
    // The service admits/charges this verified target before reading or parsing bytes.
    const assets = await transferClipboardAssets(session.user.id, uid, async () => {
      const bounded = await boundedRequest(request, 256_000);
      return bounded.json().catch(() => {
        throw new ClipboardTransferError("Invalid clipboard image request.");
      });
    });
    return Response.json({ assets }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (cause) {
    if (cause instanceof RequestBodyError) return requestBodyError(cause);
    const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
    if (cause instanceof MutationBudgetError) {
      headers["Retry-After"] = String(cause.retryAfter);
      return Response.json({ error: cause.message }, { status: 429, headers });
    }
    if (cause instanceof ClipboardBudgetUnavailableError)
      return Response.json({ error: cause.message }, { status: 503, headers });
    if (cause instanceof ClipboardAccessError)
      return Response.json({ error: cause.message }, { status: 403, headers });
    if (cause instanceof ClipboardTransferError)
      return Response.json({ error: cause.message }, { status: 400, headers });
    const limit = planLimitMessage(cause);
    return Response.json(
      { error: limit ?? "Could not copy clipboard images." },
      { status: limit ? 409 : 503, headers },
    );
  }
}
