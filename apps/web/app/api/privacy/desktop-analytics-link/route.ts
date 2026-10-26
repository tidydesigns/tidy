import { z } from "zod";
import { privacyAccount, privacyFailure, privateHeaders } from "@/lib/privacy/access";
import { withRequestBodyLimit } from "@/lib/http/request-body";
import {
  analyticsStorageEnabled,
  analyticsEnabled,
  AnalyticsAccessError,
  linkAnalyticsAccount,
  unlinkAnalyticsAccount,
} from "@/lib/analytics/store";
async function handle(request: Request) {
  if (!analyticsStorageEnabled())
    return new Response(null, { status: 503, headers: privateHeaders });
  try {
    const session = await privacyAccount(request, "privacy-consent");
    const input = z
      .discriminatedUnion("action", [
        z
          .object({ action: z.literal("link"), challenge: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict(),
        z.object({ action: z.literal("unlink") }).strict(),
      ])
      .parse(await request.json());
    if (input.action === "link") {
      if (!analyticsEnabled()) return new Response(null, { status: 503, headers: privateHeaders });
      await linkAnalyticsAccount(input.challenge, session.user.id);
    } else await unlinkAnalyticsAccount(session.user.id);
    return new Response(null, { status: 204, headers: privateHeaders });
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      error instanceof AnalyticsAccessError
    )
      return Response.json(
        { error: "This request is invalid or expired. Start linking again from desktop." },
        { status: 400, headers: privateHeaders },
      );
    return privacyFailure(error);
  }
}
export const POST = withRequestBodyLimit(handle, 1024);
