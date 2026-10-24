import { z } from "zod";
import {
  ANALYTICS_NOTICE,
  analyticsChoicesSchema,
  analyticsEnvelopeSchema,
} from "@tidy/design/analytics";
import { withRequestBodyLimit } from "@/lib/http/request-body";
import { reservePersonalAttempts } from "@/lib/security/personal-budget";
import {
  analyticsStorageEnabled,
  analyticsEnabled,
  AnalyticsAccessError,
  nativeConsent,
  captureNative,
  eraseNative,
  createAnalyticsLink,
  exportNative,
} from "@/lib/analytics/store";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
async function handle(request: Request, context: { params: Promise<{ action: string }> }) {
  if (!analyticsStorageEnabled()) return new Response(null, { status: 503, headers });
  // Native clients use a dedicated bearer receipt, never ambient browser cookies or cloud credentials.
  if (request.headers.has("origin") || request.headers.has("cookie"))
    return new Response(null, { status: 403, headers });
  try {
    const { action } = await context.params;
    if (!analyticsEnabled() && !["erase", "unlink", "status", "export"].includes(action))
      return new Response(null, { status: 503, headers });
    const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (token && !/^[a-f0-9]{64}$/.test(token)) return new Response(null, { status: 401, headers });
    await reservePersonalAttempts(
      "privacy-consent",
      `native:${request.headers.get("cf-connecting-ip") || "unknown"}`,
    );
    const body: unknown = await request.json();
    if (action === "receipt") {
      const value = z
        .object({
          notice: z.literal(ANALYTICS_NOTICE),
          choices: analyticsChoicesSchema,
          revision: z.number().int().positive().optional(),
        })
        .strict()
        .parse(body);
      const receipt = await nativeConsent(token, value.choices, value.revision);
      return Response.json(receipt, { headers });
    }
    if (!token) return new Response(null, { status: 401, headers });
    if (action === "events") {
      const value = z
        .object({
          revision: z.number().int().positive(),
          events: z.array(analyticsEnvelopeSchema).min(1).max(25),
        })
        .strict()
        .parse(body);
      await captureNative(token, value.revision, value.events);
      return new Response(null, { status: 204, headers });
    }
    z.object({}).strict().parse(body);
    if (action === "erase" || action === "unlink") {
      await eraseNative(token, action === "unlink");
      return new Response(null, { status: 204, headers });
    }
    if (action === "status") return Response.json(await nativeConsent(token), { headers });
    if (action === "export") return Response.json(await exportNative(token), { headers });
    if (action === "link") {
      const challenge = await createAnalyticsLink(token);
      return Response.json(
        {
          url: new URL(
            `/privacy/desktop-link?challenge=${challenge}`,
            process.env.BETTER_AUTH_URL || request.url,
          ).href,
        },
        { headers },
      );
    }
    return new Response(null, { status: 404, headers });
  } catch (error) {
    return new Response(null, {
      status: error instanceof AnalyticsAccessError ? 401 : error instanceof z.ZodError ? 400 : 503,
      headers,
    });
  }
}
export const POST = withRequestBodyLimit(handle, 32_768);
