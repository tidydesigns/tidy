import { withAuthRequestBodyLimit } from "@/lib/auth/request-body";
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { privacyReauthCallback } from "@/lib/privacy/reauth-callback";

const handlers = toNextJsHandler(auth);
export function GET(request: Request) {
  const url = new URL(request.url);
  if (
    url.pathname === "/api/auth/callback/github" &&
    url.searchParams.get("state")?.startsWith("privacy-github:")
  )
    return privacyReauthCallback(request, "github");
  return handlers.GET(request);
}
export const POST = withAuthRequestBodyLimit(handlers.POST);
