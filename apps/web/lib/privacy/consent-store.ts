import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  CONSENT_MAX_AGE,
  CONSENT_NOTICE_VERSION,
  consentRevision,
  hasOptionalConsent,
  type Consent,
} from "./consent";

export const RECEIPT_COOKIE = "tidy_consent_receipt";
type Decision = Consent & {
  id: string;
  browserId: string;
  userId: string | null;
  active?: boolean;
};
export function receiptToken(cookie: string | null) {
  const values = cookie
    ?.split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(`${RECEIPT_COOKIE}=`));
  const token = values?.length === 1 ? values[0].slice(RECEIPT_COOKIE.length + 1) : "";
  return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const projection =
  'id,"browserId","userId",version,at::float8 as at,analytics,replay,diagnostics,("retiredAt" is null and "expiresAt">clock_timestamp()) as active';

// The HttpOnly receipt token never reaches PostHog. Every SDK start waits for this commit.
export async function recordConsent(
  consent: Consent,
  userId: string | null,
  existingToken?: string,
) {
  const token = existingToken ?? randomBytes(32).toString("hex");
  const tokenHash = hash(token);
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `privacy-consent:${tokenHash}`,
    ]);
    const previous = (
      await client.query<Decision>(
        `select ${projection} from "privacyConsent" where "tokenHash"=$1 order by "recordedAt" desc limit 1`,
        [tokenHash],
      )
    ).rows[0];
    if (
      previous &&
      (previous.at > consent.at ||
        (previous.at === consent.at && consentRevision(previous) !== consentRevision(consent)))
    )
      throw new Error("Consent choice was superseded");
    if (
      previous &&
      previous.userId === userId &&
      consentRevision(previous) === consentRevision(consent)
    ) {
      await client.query("commit");
      return { token, decision: previous };
    }
    const sameContext = previous && (previous.userId === userId || previous.userId === null);
    const browserId = sameContext ? previous.browserId : randomUUID();
    const decision: Decision = { ...consent, id: randomUUID(), browserId, userId };
    await client.query(
      `insert into "privacyConsent" (id,"tokenHash","browserId","userId",version,"noticeVersion",at,analytics,replay,diagnostics,"expiresAt") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        decision.id,
        tokenHash,
        browserId,
        userId,
        consent.version,
        CONSENT_NOTICE_VERSION,
        consent.at,
        consent.analytics,
        consent.replay,
        consent.diagnostics,
        new Date(consent.at + CONSENT_MAX_AGE * 1000),
      ],
    );
    if (previous) {
      const withdrawn = (["analytics", "replay", "diagnostics"] as const).filter(
        (purpose) => previous[purpose] && !consent[purpose],
      );
      if (withdrawn.length)
        await client.query(
          `insert into "privacyCleanup" (id,kind,subject) values ($1,'posthog-review',$2)`,
          [
            randomUUID(),
            JSON.stringify({
              reason: "withdrawal",
              distinctIds: [
                ...new Set([previous.browserId, previous.userId ?? userId].filter(Boolean)),
              ],
              identityVerificationRequired: !sameContext,
              withdrawn,
              remaining: {
                analytics: consent.analytics,
                replay: consent.replay,
                diagnostics: consent.diagnostics,
              },
              receipt: decision.id,
            }),
          ],
        );
      if (sameContext)
        await client.query('update "privacyConsent" set "retiredAt"=now() where id=$1', [
          previous.id,
        ]);
      if (analyticsStorageEnabled() && (!consent.analytics || !sameContext))
        await client.query(
          `delete from "productAnalyticsEvent" where "browserConsentId" in (select id from "privacyConsent" where "browserId"=$1)`,
          [previous.browserId],
        );
    }
    await client.query("commit");
    return { token, decision };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordedConsent(
  cookie: string | null,
  consent: Consent,
  receiptId: string | null,
  userId: string | null,
) {
  const token = receiptToken(cookie);
  if (!token) return false;
  const row = (
    await db.query<Decision>(
      `select ${projection} from "privacyConsent" where "tokenHash"=$1 order by "recordedAt" desc limit 1`,
      [hash(token)],
    )
  ).rows[0];
  return Boolean(
    row &&
    row.active &&
    row.id === receiptId &&
    row.userId === userId &&
    consentRevision(row) === consentRevision(consent),
  );
}

export async function authorizeTelemetry(request: Request, consent: Consent) {
  const { auth } = await import("@/lib/auth");
  const session = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  return recordedConsent(
    request.headers.get("cookie"),
    consent,
    request.headers.get("x-tidy-receipt"),
    session?.user.id ?? null,
  );
}

// Run by the existing cleanup cron, including when the browser never returns.
export async function maintainConsentRecords() {
  const client = await db.connect();
  try {
    await client.query("begin");
    const rows = (
      await client.query<Decision>(
        `select ${projection} from "privacyConsent" where "retiredAt" is null and "expiresAt"<=now() order by "expiresAt" for update skip locked limit 100`,
      )
    ).rows;
    for (const row of rows) {
      if (hasOptionalConsent(row))
        await client.query(
          `insert into "privacyCleanup" (id,kind,subject) values ($1,'posthog-review',$2)`,
          [
            randomUUID(),
            JSON.stringify({
              reason: "expiry",
              distinctIds: [...new Set([row.browserId, row.userId].filter(Boolean))],
              withdrawn: ["analytics", "replay", "diagnostics"],
              receipt: row.id,
            }),
          ],
        );
      await client.query('update "privacyConsent" set "retiredAt"=now() where id=$1', [row.id]);
    }
    await client.query(
      `delete from "privacyConsent" where "recordedAt"<now()-interval '1 year' and "retiredAt" is not null`,
    );
    await client.query(
      `delete from "privacyCleanupReceipt" where "completedAt"<now()-interval '1 year'`,
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
import { analyticsStorageEnabled } from "@/lib/analytics/store";
