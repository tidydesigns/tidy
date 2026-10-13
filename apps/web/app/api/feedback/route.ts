import { auth } from "@/lib/auth";
import { storeFeedback } from "@/lib/feedback/submissions";
import { reservePersonalAttempts } from "@/lib/security/personal-budget";
import { boundedRequest } from "@/lib/http/request-body";
import { PrivacyError, privacyFailure, privateHeaders } from "@/lib/privacy/access";
import { UUID } from "@/lib/feedback/validation";
export async function POST(request: Request) {
  try {
    if (
      request.headers.get("origin") !== new URL(process.env.BETTER_AUTH_URL || request.url).origin
    )
      throw new PrivacyError("Request denied.", 403);
    const account = await auth.api.getSession({ headers: request.headers });
    if (!account?.user.emailVerified) throw new PrivacyError("Sign in to send feedback.", 401);
    await reservePersonalAttempts("feedback-submit", account.user.id);
    const data = (await (await boundedRequest(request, 50000)).json()) as {
      id?: unknown;
      category?: unknown;
      message?: unknown;
    };
    if (
      typeof data.id !== "string" ||
      !UUID.test(data.id) ||
      (data.category !== "broken" && data.category !== "general") ||
      typeof data.message !== "string" ||
      !data.message.trim() ||
      data.message.length > 10000
    )
      throw new PrivacyError("Enter feedback of 10,000 characters or fewer.");
    await storeFeedback(account.user.id, data.id, data.category, data.message.trim());
    return Response.json({ received: true }, { headers: privateHeaders });
  } catch (error) {
    return privacyFailure(error);
  }
}
