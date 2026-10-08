import { auth } from "@/lib/auth";
import { getDesignFile } from "@/lib/design/service";
import { getDocument } from "@/lib/design/document-service";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: RouteContext<"/api/files/[uid]/snapshot">) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });
  const { uid } = await params;
  const document = await getDocument(session.user.id, uid);
  const file = await getDesignFile(session.user.id, uid, !document?.content.legacyConverted);
  if (!file) return new Response(null, { status: 404 });
  return Response.json(
    {
      name: file.name,
      updatedAt: file.updatedAt,
      frames: file.frames,
      rectangles: file.rectangles,
      document,
    },
    {
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
