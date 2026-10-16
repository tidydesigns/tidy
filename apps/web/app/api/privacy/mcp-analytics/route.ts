import { privacyAccount, privacyFailure, privateHeaders, PrivacyError } from "@/lib/privacy/access";
import { MCP_NOTICE_VERSION } from "@/lib/privacy/consent";
import { setMcpConsent } from "@/lib/privacy/mcp-consent";
import { withRequestBodyLimit } from "@/lib/http/request-body";

export const POST = withRequestBodyLimit(async (request: Request) => {
  try {
    const account = await privacyAccount(request, "privacy-consent");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new PrivacyError("Choose On or Off.");
    }
    if (
      !body ||
      typeof body !== "object" ||
      !("enabled" in body) ||
      typeof body.enabled !== "boolean" ||
      Object.keys(body).some((key) => !["enabled", "noticeVersion"].includes(key))
    )
      throw new PrivacyError("Choose On or Off.");
    // An old open page cannot grant a materially changed purpose. Withdrawal
    // remains available even when the page's notice version is out of date.
    if (body.enabled && (!("noticeVersion" in body) || body.noticeVersion !== MCP_NOTICE_VERSION))
      throw new PrivacyError("Reload Tidy to review the current MCP analytics notice.", 409);
    return Response.json(await setMcpConsent(account.user.id, account.session.id, body.enabled), {
      headers: privateHeaders,
    });
  } catch (error) {
    return privacyFailure(error);
  }
}, 1024);
