import { auth } from "@/lib/auth";
import { readAttachment } from "@/lib/feedback/storage";
import { FeedbackError, UUID } from "@/lib/feedback/validation";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/feedback/attachments/[id]/[index]">,
) {
  const { id, index } = await params;
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (!UUID.test(id) || !/^[0-2]$/.test(index)) return new Response(null, { status: 404, headers });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", `/api/feedback/attachments/${id}/${index}`);
    return new Response(null, { status: 302, headers: { ...headers, Location: login.href } });
  }
  try {
    const attachment = await readAttachment(session.user, id, Number(index));
    if (!attachment) return new Response(null, { status: 404, headers });
    const { object } = attachment;
    return new Response(object.body, {
      headers: {
        ...headers,
        "Content-Type": attachment.type,
        "Content-Length": String(object.size),
        "Content-Disposition": "inline",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    console.error("Feedback attachment read failed", error);
    return new Response(
      error instanceof FeedbackError ? error.message : "Could not load image. Please try again.",
      { status: 503, headers },
    );
  }
}
