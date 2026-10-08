import { cookies } from "next/headers";
import { githubConfig } from "@/lib/github/config";
import { completeAuthorization } from "@/lib/github/oauth";
import { requestSession } from "@/lib/github/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const destination = new URL("/settings?tab=connectors&connector=github", githubConfig().origin);
  const jar = await cookies();
  const cookieState = jar.get("github_oauth_state")?.value;
  jar.delete("github_oauth_state");
  try {
    const session = await requestSession(request);
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error")) throw new Error("Authorization declined.");
    const { organizationId } = await completeAuthorization(
      session.user.id,
      state,
      cookieState,
      code,
      session.session.id,
    );
    destination.searchParams.set("connectorOrganization", organizationId);
    destination.searchParams.set("github", "connected");
  } catch {
    destination.searchParams.set("github", "retry");
  }
  return new Response(null, {
    status: 303,
    headers: { Location: destination.href, "Cache-Control": "no-store" },
  });
}
