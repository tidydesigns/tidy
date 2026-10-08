import { auth } from "@/lib/auth";
import { thumbnailResponseForUser, uploadThumbnailForUser } from "@/lib/design/thumbnail-service";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: RouteContext<"/api/files/[uid]/thumbnail">,
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });
  return thumbnailResponseForUser(session.user.id, (await params).uid, request);
}

export async function POST(
  request: Request,
  { params }: RouteContext<"/api/files/[uid]/thumbnail">,
) {
  if (
    request.headers.get("origin") !==
    new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").origin
  )
    return new Response(null, { status: 403 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });
  return uploadThumbnailForUser(session.user.id, (await params).uid, request);
}
