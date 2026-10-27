import { auth } from "@/lib/auth";
import { analyticsEnabled, hasAnalyticsLink } from "@/lib/analytics/store";
import { privateHeaders, privacyFailure } from "@/lib/privacy/access";
import { reservePersonalAttempts, PersonalBudgetError } from "@/lib/security/personal-budget";
import { withRequestBodyLimit } from "@/lib/http/request-body";
import { readConsent, consentCookie, CONSENT_VERSION, ESSENTIAL_ONLY } from "@/lib/privacy/consent";
import { recordConsent, receiptToken, RECEIPT_COOKIE } from "@/lib/privacy/consent-store";

async function record(request: Request) {
  if (
    request.headers.get("origin") !== new URL(process.env.BETTER_AUTH_URL || request.url).origin ||
    request.headers.get("x-tidy-privacy") !== "1"
  )
    return new Response(null, { status: 403, headers: privateHeaders });
  try {
    let consent = readConsent(request.headers.get("cookie"));
    // Next.js may expose an empty POST as a non-null stream. Inspect its bytes.
    const bodyText = await request.text();
    const revoking = bodyText.length > 0;
    // A refusal must still reach the operator when a browser rejects JS cookie writes.
    // This body can only revoke every optional browser purpose; it cannot grant tracking.
    if (revoking) {
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        return new Response(null, { status: 400, headers: privateHeaders });
      }
      if (
        !body ||
        typeof body !== "object" ||
        !("revoke" in body) ||
        body.revoke !== true ||
        Object.keys(body).length !== 1
      )
        return new Response(null, { status: 400, headers: privateHeaders });
      consent = {
        ...ESSENTIAL_ONLY,
        version: CONSENT_VERSION,
        at: Math.max(Date.now(), (consent?.at ?? 0) + 1),
      };
    }
    if (!consent) return new Response(null, { status: 400, headers: privateHeaders });
    // Cloudflare overwrites this header; the guard stores an HMAC, never the raw IP.
    // This budget also bounds anonymous receipt creation before resolving a session.
    await reservePersonalAttempts(
      "privacy-consent",
      `ip:${request.headers.get("cf-connecting-ip") || "unknown"}`,
    );
    const session = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
    const { token, decision } = await recordConsent(
      consent,
      session?.user.id ?? null,
      receiptToken(request.headers.get("cookie")),
    );
    const secure = new URL(process.env.BETTER_AUTH_URL || request.url).protocol === "https:";
    const headers = new Headers(privateHeaders);
    headers.append(
      "Set-Cookie",
      `${RECEIPT_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=31536000${secure ? "; Secure" : ""}`,
    );
    // Ordinary receipt responses must never overwrite a newer browser choice.
    // Only the revoke-only fallback may set the projection, and only to essential.
    if (revoking) headers.append("Set-Cookie", consentCookie(consent, consent.at, secure));
    return Response.json(
      {
        id: decision.id,
        browserId: decision.browserId,
        user: session ? { id: session.user.id, email: session.user.email } : null,
        productAnalytics:
          analyticsEnabled() && consent.analytics && session
            ? await hasAnalyticsLink(session.user.id)
            : false,
      },
      { headers },
    );
  } catch (error) {
    if (error instanceof PersonalBudgetError) return privacyFailure(error);
    console.error(JSON.stringify({ event: "privacy_consent_unavailable" }));
    return Response.json(
      {
        error: "Could not record your privacy choice. Optional collection stays off; please retry.",
      },
      { status: 503, headers: privateHeaders },
    );
  }
}
export const POST = withRequestBodyLimit(record, 1024);
