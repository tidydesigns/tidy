import { auth } from "@/lib/auth";
import { getDesignFile } from "@/lib/design/service";
import { realtimeSchemaReady } from "@/lib/realtime/server";
import { signTicket } from "@/lib/realtime/ticket";

export const runtime = "nodejs";
export async function POST(
  request: Request,
  { params }: RouteContext<"/api/files/[uid]/presence-ticket">,
) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return new Response(null, { status: 403 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });
  const { uid } = await params;
  const file = await getDesignFile(session.user.id, uid, false);
  if (!file) return new Response(null, { status: 404 });
  if (!(await realtimeSchemaReady()))
    return Response.json(
      { error: "Live files require the multiplayer migration." },
      { status: 503 },
    );
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret)
    return Response.json({ error: "Live file authentication is not configured." }, { status: 503 });
  const expiresAt = Date.now() + 5 * 60_000;
  const sessionId = crypto.randomUUID();
  const ticket = await signTicket(
    {
      purpose: "file-room",
      fileId: uid,
      organizationId: file.organizationId,
      userId: session.user.id,
      name: session.user.name,
      image: session.user.image ?? null,
      sessionId,
      authSessionId: session.session.id,
      expiresAt,
    },
    secret,
  );
  const url = new URL(
    `/api/files/${encodeURIComponent(uid)}/live`,
    process.env.BELLA_REALTIME_URL ?? request.url,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return Response.json(
    { url: url.href, expiresAt, sessionId },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
