import { cookies } from "next/headers";
import { connectorOrigin, connectorSession } from "@/lib/connectors/http";
import { connectorsHref } from "@/lib/connectors/catalog";
import { completeLinearAuthorization } from "@/lib/linear/oauth";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const destination = new URL(connectorsHref("linear"), connectorOrigin());
  const jar = await cookies();
  const cookieState = jar.get("linear_oauth_state")?.value;
  jar.delete("linear_oauth_state");
  try {
    const session = await connectorSession(request);
    const url = new URL(request.url);
    if (url.searchParams.has("error")) throw new Error("Authorization declined.");
    const { organizationId } = await completeLinearAuthorization(
      session.user.id,
      url.searchParams.get("state"),
      cookieState,
      url.searchParams.get("code"),
      session.session.id,
    );
    destination.searchParams.set("connectorOrganization", organizationId);
    destination.searchParams.set("linear", "connected");
  } catch {
    destination.searchParams.set("linear", "retry");
  }
  return new Response(null, {
    status: 303,
    headers: { Location: destination.href, "Cache-Control": "no-store" },
  });
}
