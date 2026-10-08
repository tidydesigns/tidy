import { verifyTicket } from "./ticket";

export async function upgradeFileRoom(
  request: Request,
  env: CloudflareEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/api\/files\/([^/]+)\/live$/.exec(url.pathname);
  if (!match) return null;
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return new Response(null, { status: 426 });
  const origin = request.headers.get("origin");
  if (!origin || origin !== env.BETTER_AUTH_URL) return new Response(null, { status: 403 });
  const ticket = await verifyTicket(url.searchParams.get("ticket") ?? "", env.BETTER_AUTH_SECRET);
  if (!ticket || ticket.fileId !== decodeURIComponent(match[1]))
    return new Response(null, { status: 403 });
  const headers = new Headers(request.headers);
  headers.delete("X-Bella-Actor");
  headers.set("X-Bella-Ticket", url.searchParams.get("ticket")!);
  return env.FILE_ROOMS.getByName(ticket.fileId).fetch(new Request(request, { headers }));
}
