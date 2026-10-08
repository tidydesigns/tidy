import { withRequestBodyLimit } from "@/lib/http/request-body";
import { auth } from "@/lib/auth";
import { fileVersionsForUser } from "@/lib/design/file-versions";

export const runtime = "nodejs";

async function post(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return new Response(null, { status: 403 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const ids = body && typeof body === "object" && "ids" in body ? body.ids : null;
  if (
    !Array.isArray(ids) ||
    ids.length > 100 ||
    ids.some((id) => typeof id !== "string" || id.length < 1 || id.length > 120)
  ) {
    return Response.json({ error: "Choose up to 100 files." }, { status: 400 });
  }
  if (!ids.length)
    return Response.json(
      { versions: {}, thumbnailVersions: {} },
      { headers: { "Cache-Control": "private, no-store" } },
    );

  return Response.json(await fileVersionsForUser(session.user.id, ids), {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export const POST = withRequestBodyLimit(post);
