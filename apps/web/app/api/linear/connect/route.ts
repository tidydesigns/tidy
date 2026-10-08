import { withRequestBodyLimit } from "@/lib/http/request-body";
import { cookies } from "next/headers";
import { z } from "zod";
import { connectorError, connectorOrigin, connectorSession } from "@/lib/connectors/http";
import { beginLinearAuthorization } from "@/lib/linear/oauth";
export const runtime = "nodejs";
async function post(request: Request) {
  try {
    const session = await connectorSession(request, true);
    const form = await request.formData();
    const { organizationId, accountId } = z
      .object({
        organizationId: z.string().min(1).max(200),
        accountId: z.string().uuid().optional(),
      })
      .parse({
        organizationId: form.get("organizationId"),
        accountId: form.get("accountId") ?? undefined,
      });
    const { state, url } = await beginLinearAuthorization(
      session.user.id,
      organizationId,
      session.session.id,
      accountId,
    );
    (await cookies()).set("linear_oauth_state", state, {
      httpOnly: true,
      secure: connectorOrigin().startsWith("https:"),
      sameSite: "lax",
      path: "/api/linear",
      maxAge: 600,
    });
    return new Response(null, {
      status: 303,
      headers: { Location: url, "Cache-Control": "no-store" },
    });
  } catch (error) {
    return connectorError(error);
  }
}

export const POST = withRequestBodyLimit(post, 16 * 1024);
