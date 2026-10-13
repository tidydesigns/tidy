import { auth } from "@/lib/auth";
import { boundedRequest } from "@/lib/http/request-body";
import { privacyAccount, privacyFailure, privateHeaders, PrivacyError } from "@/lib/privacy/access";
import {
  checkPrivacyAuthentication,
  reserveReauthAttempts,
  reauthMethods,
  reauthenticatePassword,
  startSocialReauth,
} from "@/lib/privacy/reauth";
export async function GET(request: Request) {
  try {
    const account = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
    if (!account) throw new PrivacyError("Sign in to continue.", 401, "SESSION_REQUIRED");
    if (new URL(request.url).searchParams.get("check") === "1") {
      await checkPrivacyAuthentication(account.user.id, account.session.id);
      return Response.json({ verified: true }, { headers: privateHeaders });
    }
    return Response.json(await reauthMethods(account.user.id), { headers: privateHeaders });
  } catch (error) {
    return privacyFailure(error);
  }
}
export async function POST(request: Request) {
  try {
    const { user, session } = await privacyAccount(request, "privacy-reauth");
    await reserveReauthAttempts(user.id);
    const data = (await (await boundedRequest(request, 2048)).json()) as {
      provider?: unknown;
      password?: unknown;
    } | null;
    if (data?.provider === "google" || data?.provider === "github")
      return Response.json(
        { url: await startSocialReauth(data.provider, user.id, session.id) },
        { headers: privateHeaders },
      );
    if (
      data?.provider !== "password" ||
      typeof data.password !== "string" ||
      !data.password ||
      data.password.length > 128
    )
      throw new PrivacyError("Enter your current password.");
    await reauthenticatePassword(user.id, session.id, data.password);
    return Response.json({ verified: true }, { headers: privateHeaders });
  } catch (error) {
    return privacyFailure(error);
  }
}
