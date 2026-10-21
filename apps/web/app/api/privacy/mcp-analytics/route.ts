import { auth } from "@/lib/auth";
import { privacyFailure, privateHeaders, PrivacyError } from "@/lib/privacy/access";
import { MCP_NOTICE_VERSION } from "@/lib/privacy/consent";
import {
  MCP_INTENT_COOKIE,
  mcpIntentToken,
  mcpConsentPreference,
  pendingMcpConsent,
  recordMcpConsentIntent,
  claimMcpConsentIntent,
  setMcpConsent,
} from "@/lib/privacy/mcp-consent";
import { reservePersonalAttempts } from "@/lib/security/personal-budget";
import { withRequestBodyLimit } from "@/lib/http/request-body";

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
    const pending = await pendingMcpConsent(mcpIntentToken(request.headers.get("cookie")));
    const choice = session
      ? await mcpConsentPreference(session.user.id)
      : (pending ?? { enabled: false });
    return Response.json(
      { ...choice, signedIn: Boolean(session), pending: Boolean(pending) },
      { headers: privateHeaders },
    );
  } catch (error) {
    return privacyFailure(error);
  }
}

export const POST = withRequestBodyLimit(async (request: Request) => {
  try {
    if (
      request.headers.get("origin") !==
        new URL(process.env.BETTER_AUTH_URL || request.url).origin ||
      request.headers.get("x-tidy-privacy") !== "1"
    )
      throw new PrivacyError("Reload Tidy at its configured app address and try again.", 403);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new PrivacyError("Choose On or Off.");
    }
    const applying = Boolean(
      body &&
      typeof body === "object" &&
      "applyPending" in body &&
      body.applyPending === true &&
      Object.keys(body).length === 1,
    );
    if (
      !applying &&
      (!body ||
        typeof body !== "object" ||
        !("enabled" in body) ||
        typeof body.enabled !== "boolean" ||
        Object.keys(body).some((key) => !["enabled", "noticeVersion"].includes(key)))
    )
      throw new PrivacyError("Choose On or Off.");
    const enabled = !applying && (body as { enabled: boolean }).enabled;
    if (enabled && (body as { noticeVersion?: unknown }).noticeVersion !== MCP_NOTICE_VERSION)
      throw new PrivacyError("Reload Tidy to review the current MCP privacy notice.", 409);
    await reservePersonalAttempts(
      "privacy-consent",
      `ip:${request.headers.get("cf-connecting-ip") || "unknown"}`,
    );
    const session = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
    if (session) await reservePersonalAttempts("privacy-consent", session.user.id);
    const token = mcpIntentToken(request.headers.get("cookie"));
    if (applying) {
      if (!session)
        throw new PrivacyError("Sign in to apply your privacy choice.", 401, "SESSION_REQUIRED");
      if (token) await claimMcpConsentIntent(session.user.id, session.session.id, token);
      return Response.json(await mcpConsentPreference(session.user.id), {
        headers: privateHeaders,
      });
    }
    if (session) {
      const choice = await setMcpConsent(session.user.id, session.session.id, enabled, token);
      return Response.json(choice, { headers: privateHeaders });
    }
    const intent = await recordMcpConsentIntent(enabled, token);
    const secure = new URL(process.env.BETTER_AUTH_URL || request.url).protocol === "https:";
    const headers = new Headers(privateHeaders);
    headers.append(
      "Set-Cookie",
      `${MCP_INTENT_COOKIE}=${intent.token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=7776000${secure ? "; Secure" : ""}`,
    );
    return Response.json({ enabled }, { headers });
  } catch (error) {
    return privacyFailure(error);
  }
}, 1024);
