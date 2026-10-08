import { withRequestBodyLimit } from "@/lib/http/request-body";
import { cookies } from "next/headers";
import { githubConfig } from "@/lib/github/config";
import { beginAuthorization } from "@/lib/github/oauth";
import { apiError, requestSession } from "@/lib/github/http";
import { GitHubRequestError } from "@/lib/github/request-error";

export const runtime = "nodejs";
async function post(request: Request) {
  try {
    const session = await requestSession(request, true);
    const organizationId = (await request.formData()).get("organizationId");
    if (typeof organizationId !== "string") throw new GitHubRequestError("Choose an organisation.");
    const { state, url } = await beginAuthorization(
      session.user.id,
      organizationId,
      session.session.id,
    );
    const config = githubConfig();
    (await cookies()).set("github_oauth_state", state, {
      httpOnly: true,
      secure: config.origin.startsWith("https:"),
      sameSite: "lax",
      path: "/api/github",
      maxAge: 600,
    });
    return new Response(null, {
      status: 303,
      headers: { Location: url, "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}

export const POST = withRequestBodyLimit(post, 16 * 1024);
