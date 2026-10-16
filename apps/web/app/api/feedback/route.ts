import { auth } from "@/lib/auth";
import { storeFeedback } from "@/lib/feedback/submissions";
import { reservePersonalAttempts } from "@/lib/security/personal-budget";
import { boundedRequest } from "@/lib/http/request-body";
import { PrivacyError, privacyFailure, privateHeaders } from "@/lib/privacy/access";
import { UUID } from "@/lib/feedback/validation";
import { z } from "zod";

const feedbackSchema = z.object({
  id: z.string().regex(UUID),
  category: z.enum(["broken", "general"]),
  message: z
    .string()
    .max(10000)
    .transform((value) => value.trim())
    .pipe(z.string().min(1)),
});
export async function POST(request: Request) {
  try {
    if (
      request.headers.get("origin") !== new URL(process.env.BETTER_AUTH_URL || request.url).origin
    )
      throw new PrivacyError("Request denied.", 403);
    const account = await auth.api.getSession({ headers: request.headers });
    if (!account?.user.emailVerified) throw new PrivacyError("Sign in to send feedback.", 401);
    await reservePersonalAttempts("feedback-submit", account.user.id);
    const bounded = await boundedRequest(request, 50000);
    const input = feedbackSchema.safeParse(await bounded.json().catch(() => null));
    if (!input.success) throw new PrivacyError("Enter feedback of 10,000 characters or fewer.");
    const { id, category, message } = input.data;
    await storeFeedback(account.user.id, id, category, message);
    return Response.json({ received: true }, { headers: privateHeaders });
  } catch (error) {
    return privacyFailure(error);
  }
}
