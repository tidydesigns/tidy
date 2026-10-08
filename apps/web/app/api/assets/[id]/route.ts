import { observeOperation } from "@/lib/operation-observability";
import { auth } from "@/lib/auth";
import { assetResponseForUser } from "@/lib/design/asset-response";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: RouteContext<"/api/assets/[id]">) {
  const session = await observeOperation(request.headers, "asset.session", () =>
    auth.api.getSession({ headers: request.headers }),
  );
  if (!session) return new Response(null, { status: 401 });
  const { id } = await params;
  return observeOperation(request.headers, "asset.query", () =>
    assetResponseForUser(session.user.id, id, request),
  );
}
