import { operationBudgetResponse } from "@/lib/security/operation-budget";
import { auth } from "@/lib/auth";
import { getFileSnapshot } from "@/lib/design/document-service";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: RouteContext<"/api/files/[uid]/snapshot">) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });
  const denied = await operationBudgetResponse("document-read", session.user.id);
  if (denied) return denied;
  const { uid } = await params;
  const snapshot = await getFileSnapshot(session.user.id, uid);
  if (!snapshot) return new Response(null, { status: 404 });
  return Response.json(snapshot, { headers: { "Cache-Control": "private, no-store" } });
}
