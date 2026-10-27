import "server-only";
import { z } from "zod";
import { createHash } from "node:crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { analyticsEnabled } from "@/lib/analytics/store";
import { readConsent, consentRevision } from "@/lib/privacy/consent";
import { recordedConsent, receiptToken } from "@/lib/privacy/consent-store";
import { reservePersonalAttempts } from "@/lib/security/personal-budget";
const headers = { "Cache-Control": "private, no-store" };
export async function captureWebRequest(request: Request) {
  if (!analyticsEnabled()) return new Response(null, { status: 503, headers });
  if (request.headers.get("origin") !== new URL(process.env.BETTER_AUTH_URL || request.url).origin)
    return new Response(null, { status: 403, headers });
  const consent = readConsent(request.headers.get("cookie"));
  if (!consent?.analytics || request.headers.get("x-tidy-consent") !== consentRevision(consent))
    return new Response(null, { status: 403, headers });
  try {
    const input = z
      .object({
        id: z.uuid(),
        event: z.discriminatedUnion("name", [
          z.object({ name: z.literal("product_active_day") }).strict(),
          z
            .object({
              name: z.literal("design_file_created"),
              storage: z.literal("cloud"),
              kind: z.literal("new"),
            })
            .strict(),
        ]),
      })
      .strict()
      .parse(await request.json());
    await reservePersonalAttempts(
      "privacy-consent",
      `web-analytics:${request.headers.get("cf-connecting-ip") || "unknown"}`,
    );
    const session = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
    const receipt = request.headers.get("x-tidy-receipt");
    const token = receiptToken(request.headers.get("cookie"));
    if (
      !token ||
      !(await recordedConsent(
        request.headers.get("cookie"),
        consent,
        receipt,
        session?.user.id ?? null,
      ))
    )
      return new Response(null, { status: 403, headers });
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `privacy-consent:${createHash("sha256").update(token).digest("hex")}`,
      ]);
      const row = (
        await client.query<{ browserId: string }>(
          `select "browserId" from "privacyConsent" where id=$1 and "retiredAt" is null and analytics=true and "expiresAt">clock_timestamp() for share`,
          [receipt],
        )
      ).rows[0];
      if (row) {
        const account = session
          ? (
              await client.query<{ id: string }>(
                `select a.id from "productAnalyticsAccount" a where a."userId"=$1 and exists(select 1 from "desktopAnalyticsConsent" d where d."accountId"=a.id and d.usage=true and d."expiresAt">clock_timestamp())`,
                [session.user.id],
              )
            ).rows[0]?.id
          : null;
        // Collect web activity only for explicitly linked accounts; existing web analytics remains separate.
        if (account) {
          const { name, ...properties } = input.event;
          await client.query(
            `insert into "productAnalyticsEvent" (id,"browserConsentId","accountId",subject,surface,purpose,name,at,"expiresAt",properties) values ($1,$2,$3,$4,'web','usage',$5,clock_timestamp(),clock_timestamp()+interval '90 days',$6::jsonb) on conflict do nothing`,
            [input.id, receipt, account, `web:${row.browserId}`, name, JSON.stringify(properties)],
          );
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return new Response(null, { status: 204, headers });
  } catch (error) {
    return new Response(null, { status: error instanceof z.ZodError ? 400 : 503, headers });
  }
}
