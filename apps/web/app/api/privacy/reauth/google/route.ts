import { auth } from "@/lib/auth";
import { finishGoogleReauth } from "@/lib/privacy/reauth";
import { privateHeaders } from "@/lib/privacy/access";
export async function GET(request: Request) {
  let success = false;
  try {
    const account = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
    const params = new URL(request.url).searchParams;
    if (account && !params.has("error")) {
      await finishGoogleReauth(
        account.user.id,
        account.session.id,
        params.get("state") ?? "",
        params.get("code") ?? "",
      );
      success = true;
    }
  } catch {
    /* Do not expose provider tokens, callback codes or error details. */
  }
  const destination = new URL(
    "/account/privacy/reauth",
    process.env.BETTER_AUTH_URL || request.url,
  );
  destination.searchParams.set("result", success ? "success" : "error");
  return new Response(null, {
    status: 303,
    headers: { ...privateHeaders, Location: destination.href, "Referrer-Policy": "no-referrer" },
  });
}
