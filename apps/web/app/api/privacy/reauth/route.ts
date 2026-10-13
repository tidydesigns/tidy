import { auth } from "@/lib/auth";
import { boundedRequest } from "@/lib/http/request-body";
import { privacyAccount, privacyFailure, privateHeaders, PrivacyError } from "@/lib/privacy/access";
import {
  reserveReauthAttempts,
  reauthMethods,
  reauthenticatePassword,
  startGoogleReauth,
} from "@/lib/privacy/reauth";
export async function GET(request: Request) {
  const account = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (!account)
    return Response.json(
      { error: "Sign in to continue." },
      { status: 401, headers: privateHeaders },
    );
  return Response.json(await reauthMethods(account.user.id), { headers: privateHeaders });
}
export async function POST(request: Request) {
  try {
    const { user, session } = await privacyAccount(request, "privacy-reauth");
    await reserveReauthAttempts(user.id);
    const data = (await (await boundedRequest(request, 2048)).json()) as {
      provider?: unknown;
      password?: unknown;
    } | null;
    if (data?.provider === "google")
      return Response.json(
        { url: await startGoogleReauth(user.id, session.id) },
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
