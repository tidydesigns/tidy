import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { analyticsSetting } from "./config";
import {
  ANALYTICS_NOTICE,
  ANALYTICS_DAYS,
  analyticsPurpose,
  analyticsEnvelopeSchema,
  type AnalyticsChoices,
  type AnalyticsEnvelope,
} from "@tidy/design/analytics";

export const analyticsStorageEnabled = () =>
  analyticsSetting("DESKTOP_ANALYTICS_STORAGE_ENABLED") === "1";
export const analyticsEnabled = () =>
  analyticsStorageEnabled() && analyticsSetting("DESKTOP_ANALYTICS_ENABLED") === "1";
export const analyticsHash = (value: string) => createHash("sha256").update(value).digest("hex");
export class AnalyticsAccessError extends Error {}
type Consent = AnalyticsChoices & {
  id: string;
  revision: number;
  expiresAt: Date;
  accountId: string | null;
  notice: string;
};
export async function nativeConsent(token: string, choices?: AnalyticsChoices, revision?: number) {
  const client = await db.connect();
  await client.query("begin");
  try {
    let row = token
      ? (
          await client.query<Consent>(
            'select * from "desktopAnalyticsConsent" where "tokenHash"=$1 for update',
            [analyticsHash(token)],
          )
        ).rows[0]
      : undefined;
    if (token && !row) throw new AnalyticsAccessError();
    if (choices) {
      if (row && row.revision !== revision) throw new AnalyticsAccessError();
      if (!row) {
        token = randomBytes(32).toString("hex");
        row = (
          await client.query<Consent>(
            `insert into "desktopAnalyticsConsent" (id,"tokenHash",usage,diagnostics,notice,"expiresAt") values ($1,$2,$3,$4,$5,clock_timestamp()+interval '90 days') returning *`,
            [
              randomUUID(),
              analyticsHash(token),
              choices.usage,
              choices.diagnostics,
              ANALYTICS_NOTICE,
            ],
          )
        ).rows[0];
      } else {
        // Withdrawal and collection serialize on the same receipt lock. No stale batch can restore consent.
        await client.query(
          `delete from "productAnalyticsEvent" where "consentId"=$1 and (($2=false and purpose='usage') or ($3=false and purpose='diagnostics'))`,
          [row.id, choices.usage, choices.diagnostics],
        );
        row = (
          await client.query<Consent>(
            `update "desktopAnalyticsConsent" set usage=$2,diagnostics=$3,revision=revision+1,notice=$4,"expiresAt"=clock_timestamp()+interval '90 days',"accountId"=case when $2 then "accountId" else null end,"challengeHash"=null,"challengeExpiresAt"=null where id=$1 returning *`,
            [row.id, choices.usage, choices.diagnostics, ANALYTICS_NOTICE],
          )
        ).rows[0];
      }
    }
    if (!row) throw new AnalyticsAccessError();
    await client.query("commit");
    return {
      token,
      revision: row.revision,
      expiresAt: row.expiresAt.toISOString(),
      linked: Boolean(row.accountId),
      choices: { usage: row.usage, diagnostics: row.diagnostics },
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function captureNative(token: string, revision: number, events: AnalyticsEnvelope[]) {
  const client = await db.connect();
  await client.query("begin");
  try {
    const row = (
      await client.query<Consent>(
        `select * from "desktopAnalyticsConsent" where "tokenHash"=$1 and "expiresAt">clock_timestamp() and notice=$2 for update`,
        [analyticsHash(token), ANALYTICS_NOTICE],
      )
    ).rows[0];
    if (!row || row.revision !== revision) throw new AnalyticsAccessError();
    for (const input of events) {
      const value = analyticsEnvelopeSchema.parse(input);
      const purpose = analyticsPurpose(value.event);
      if (
        !row[purpose] ||
        Date.now() - Date.parse(value.at) > 86_400_000 ||
        Date.parse(value.at) - Date.now() > 300_000
      )
        continue;
      const { name, ...properties } = value.event;
      await client.query(
        `insert into "productAnalyticsEvent" (id,"consentId","accountId",subject,surface,purpose,name,at,"expiresAt",properties) values ($1,$2::uuid,$3,$2::text,'desktop',$4,$5,$6,$6::timestamptz+make_interval(days=>$7),$8::jsonb) on conflict do nothing`,
        [
          value.id,
          row.id,
          purpose === "usage" ? row.accountId : null,
          purpose,
          name,
          value.at,
          purpose === "usage" ? ANALYTICS_DAYS : 30,
          JSON.stringify({
            ...properties,
            release: value.release,
            platform: value.platform,
            arch: value.arch,
          }),
        ],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function eraseNative(token: string, unlink = false) {
  const client = await db.connect();
  await client.query("begin");
  try {
    const row = (
      await client.query<Consent>(
        'select * from "desktopAnalyticsConsent" where "tokenHash"=$1 for update',
        [analyticsHash(token)],
      )
    ).rows[0];
    if (row) {
      await client.query(
        `delete from "productAnalyticsEvent" where "consentId"=$1 ${unlink ? 'and "accountId" is not null' : ""}`,
        [row.id],
      );
      if (unlink)
        await client.query(
          'update "desktopAnalyticsConsent" set "accountId"=null,"challengeHash"=null,"challengeExpiresAt"=null,revision=revision+1 where id=$1',
          [row.id],
        );
      else await client.query('delete from "desktopAnalyticsConsent" where id=$1', [row.id]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function createAnalyticsLink(token: string) {
  const challenge = randomBytes(32).toString("hex");
  const result = await db.query(
    `update "desktopAnalyticsConsent" set "challengeHash"=$2,"challengeExpiresAt"=clock_timestamp()+interval '5 minutes' where "tokenHash"=$1 and usage=true and "expiresAt">clock_timestamp() and notice=$3 returning id`,
    [analyticsHash(token), analyticsHash(challenge), ANALYTICS_NOTICE],
  );
  if (!result.rowCount) throw new AnalyticsAccessError();
  return challenge;
}

export async function exportNative(token: string) {
  const client = await db.connect();
  await client.query("begin isolation level repeatable read");
  try {
    const row = (
      await client.query<Consent>(
        'select * from "desktopAnalyticsConsent" where "tokenHash"=$1 for share',
        [analyticsHash(token)],
      )
    ).rows[0];
    if (!row) throw new AnalyticsAccessError();
    const size = (
      await client.query<{ count: number; bytes: string }>(
        `select count(*)::int as count,coalesce(sum(octet_length(properties::text)+512),0)::text as bytes from "productAnalyticsEvent" where "consentId"=$1 and "expiresAt">clock_timestamp()`,
        [row.id],
      )
    ).rows[0];
    if (size.count > 10000 || Number(size.bytes) > 4_000_000)
      throw new Error("Contact the operator for a larger report export.");
    const events = (
      await client.query(
        `select purpose,name,at,"expiresAt",properties from "productAnalyticsEvent" where "consentId"=$1 and "expiresAt">clock_timestamp() order by at`,
        [row.id],
      )
    ).rows;
    await client.query("commit");
    return {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      choices: {
        usage: row.usage,
        diagnostics: row.diagnostics,
        notice: row.notice,
        expiresAt: row.expiresAt,
        linked: Boolean(row.accountId),
      },
      events,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function linkAnalyticsAccount(challenge: string, userId: string) {
  const client = await db.connect();
  await client.query("begin");
  try {
    const row = (
      await client.query<Consent>(
        `select * from "desktopAnalyticsConsent" where "challengeHash"=$1 and "challengeExpiresAt">clock_timestamp() and "expiresAt">clock_timestamp() and usage=true and notice=$2 for update`,
        [analyticsHash(challenge), ANALYTICS_NOTICE],
      )
    ).rows[0];
    if (!row || row.accountId) throw new AnalyticsAccessError();
    const account = (
      await client.query<{ id: string }>(
        `insert into "productAnalyticsAccount" (id,"userId") values ($1,$2) on conflict("userId") do update set "userId"=excluded."userId" returning id`,
        [randomUUID(), userId],
      )
    ).rows[0];
    await client.query(
      'update "desktopAnalyticsConsent" set "accountId"=$2,"challengeHash"=null,"challengeExpiresAt"=null where id=$1',
      [row.id, account.id],
    );
    // Prospective only: no existing event is reassigned and no provider profiles are merged.
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function unlinkAnalyticsAccount(userId: string) {
  await db.query('delete from "productAnalyticsAccount" where "userId"=$1', [userId]);
}

export async function hasAnalyticsLink(userId: string) {
  return Boolean(
    (
      await db.query(
        `select 1 from "productAnalyticsAccount" a where a."userId"=$1 and exists(select 1 from "desktopAnalyticsConsent" d where d."accountId"=a.id and d.usage=true and d."expiresAt">clock_timestamp())`,
        [userId],
      )
    ).rowCount,
  );
}

/** The existing privacy cron enforces raw expiry; reads also exclude expired data. */
export async function maintainProductAnalytics() {
  await db.query(
    `delete from "desktopServiceMetric" where day<(clock_timestamp() at time zone 'UTC')::date-29`,
  );
  await db.query('delete from "productAnalyticsEvent" where "expiresAt"<=clock_timestamp()');
  await db.query('delete from "desktopAnalyticsConsent" where "expiresAt"<=clock_timestamp()');
  await db.query(
    `delete from "productAnalyticsAccount" a where not exists(select 1 from "desktopAnalyticsConsent" d where d."accountId"=a.id) and not exists(select 1 from "productAnalyticsEvent" e where e."accountId"=a.id)`,
  );
  await db.query(
    `update "desktopAnalyticsConsent" set "challengeHash"=null,"challengeExpiresAt"=null where "challengeExpiresAt"<=clock_timestamp()`,
  );
  await db.query(`delete from "desktopDownloadSnapshot" where day<current_date-400`);
  await db.query(`delete from "productAnalyticsExport" where day<current_date-400`);
}
