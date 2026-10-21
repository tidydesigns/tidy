import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { PrivacyError } from "./access";
import type { PoolClient } from "pg";

import { MCP_NOTICE_VERSION } from "./consent";
export const mcpAnalyticsId = (consentId: string) => `mcp:${consentId}`;

// Only a recorded choice enables account linking. An OAuth grant or browser
// analytics acceptance on an older notice never grants it.
export async function activeMcpConsent(userId: string): Promise<string | undefined> {
  return (
    await db.query<{ id: string }>(
      `select id from "mcpAnalyticsConsent" where "userId"=$1 and enabled
       and "retiredAt" is null and "expiresAt">clock_timestamp() and "noticeVersion"=$2`,
      [userId, MCP_NOTICE_VERSION],
    )
  ).rows[0]?.id;
}

export async function mcpConsentPreference(userId: string) {
  return { enabled: Boolean(await activeMcpConsent(userId)) };
}

async function queueErasure(client: PoolClient, id: string, reason: string) {
  await client.query(
    "insert into \"privacyCleanup\" (id,kind,subject) values ($1,'posthog-review',$2)",
    [
      randomUUID(),
      JSON.stringify({ reason, distinctIds: [mcpAnalyticsId(id)], withdrawn: ["mcp-analytics"] }),
    ],
  );
}

export const MCP_INTENT_COOKIE = "tidy_mcp_privacy_intent";
const intentHash = (token: string) => createHash("sha256").update(token).digest("hex");
export function mcpIntentToken(cookie: string | null) {
  const matches = cookie
    ?.split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${MCP_INTENT_COOKIE}=`));
  const token = matches?.length === 1 ? matches[0].slice(MCP_INTENT_COOKIE.length + 1) : "";
  return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

async function lockAccount(client: PoolClient, userId: string, sessionId: string) {
  const user = await client.query('select id from "user" where id=$1 for update', [userId]);
  const session = await client.query(
    `select id from session where id=$1 and "userId"=$2 and "expiresAt">clock_timestamp() for share`,
    [sessionId, userId],
  );
  if (!user.rowCount || !session.rowCount)
    throw new PrivacyError("Sign in to change your privacy choices.", 401, "SESSION_REQUIRED");
}

type CurrentChoice = { id: string; enabled: boolean; current: boolean; newer: boolean };
async function currentChoice(client: PoolClient, userId: string, intentId: string | null = null) {
  return (
    await client.query<CurrentChoice>(
      `select id,enabled,("lastChosenAt">(select "lastChosenAt" from "mcpAnalyticsConsent" where id=$3)) as newer,("expiresAt">clock_timestamp() and "noticeVersion"=$2) as current
     from "mcpAnalyticsConsent" where "userId"=$1 and "retiredAt" is null for update`,
      [userId, MCP_NOTICE_VERSION, intentId],
    )
  ).rows[0];
}
async function endChoice(client: PoolClient, choice: CurrentChoice) {
  if (choice.enabled) await queueErasure(client, choice.id, "mcp-consent-ended");
  await client.query('update "mcpAnalyticsConsent" set "retiredAt"=now() where id=$1', [choice.id]);
}
async function retireIntent(client: PoolClient, token?: string) {
  if (token)
    await client.query(
      `update "mcpAnalyticsConsent" set "retiredAt"=clock_timestamp()
     where "intentTokenHash"=$1 and "userId" is null and "retiredAt" is null`,
      [intentHash(token)],
    );
}

export async function setMcpConsent(
  userId: string,
  sessionId: string,
  enabled: boolean,
  intent?: string,
) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockAccount(client, userId, sessionId);
    // A direct account choice supersedes an older unclaimed browser intent.
    await retireIntent(client, intent);
    const previous = await currentChoice(client, userId);
    if (!previous || previous.enabled !== enabled || !previous.current) {
      if (previous) await endChoice(client, previous);
      await client.query(
        `insert into "mcpAnalyticsConsent" (id,"userId",enabled,"noticeVersion","expiresAt")
         values ($1,$2,$3,$4,clock_timestamp()+interval '90 days')`,
        [randomUUID(), userId, enabled, MCP_NOTICE_VERSION],
      );
    } else {
      await client.query(
        'update "mcpAnalyticsConsent" set "lastChosenAt"=clock_timestamp() where id=$1',
        [previous.id],
      );
    }
    await client.query("commit");
    return { enabled };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function pendingMcpConsent(token?: string) {
  if (!token) return undefined;
  return (
    await db.query<{ enabled: boolean }>(
      `select enabled from "mcpAnalyticsConsent" where "intentTokenHash"=$1 and "userId" is null
     and "retiredAt" is null and "expiresAt">clock_timestamp() and "noticeVersion"=$2`,
      [intentHash(token), MCP_NOTICE_VERSION],
    )
  ).rows[0];
}

export async function recordMcpConsentIntent(enabled: boolean, previousToken?: string) {
  const token = randomBytes(32).toString("hex");
  const client = await db.connect();
  try {
    await client.query("begin");
    await retireIntent(client, previousToken);
    await client.query(
      `insert into "mcpAnalyticsConsent" (id,"userId",enabled,"noticeVersion","expiresAt","intentTokenHash")
       values ($1,null,$2,$3,clock_timestamp()+interval '90 days',$4)`,
      [randomUUID(), enabled, MCP_NOTICE_VERSION, intentHash(token)],
    );
    await client.query("commit");
    return { token, enabled };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** A recorded pre-authentication decision can be claimed by only one account.
 * Retain the original 90-day expiry and never override a newer account choice. */
export async function claimMcpConsentIntent(userId: string, sessionId: string, token: string) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='1s'");
    await lockAccount(client, userId, sessionId);
    const pending = (
      await client.query<Pick<CurrentChoice, "id" | "enabled">>(
        `select id,enabled from "mcpAnalyticsConsent"
       where "intentTokenHash"=$1 and "userId" is null and "retiredAt" is null
       and "expiresAt">clock_timestamp() and "noticeVersion"=$2 for update`,
        [intentHash(token), MCP_NOTICE_VERSION],
      )
    ).rows[0];
    if (pending) {
      const previous = await currentChoice(client, userId, pending.id);
      if (
        previous &&
        (previous.newer || (previous.enabled === pending.enabled && previous.current))
      ) {
        await client.query(
          `update "mcpAnalyticsConsent" set "lastChosenAt"=greatest("lastChosenAt",
           (select "lastChosenAt" from "mcpAnalyticsConsent" where id=$2)) where id=$1`,
          [previous.id, pending.id],
        );
        await client.query(
          'update "mcpAnalyticsConsent" set "userId"=$2,"retiredAt"=clock_timestamp() where id=$1',
          [pending.id, userId],
        );
      } else {
        if (previous) await endChoice(client, previous);
        await client.query('update "mcpAnalyticsConsent" set "userId"=$2 where id=$1', [
          pending.id,
          userId,
        ]);
      }
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Recheck the original decision after execution and hold it through bounded
 * delivery. Withdrawal cannot complete while an earlier send is still starting. */
export async function withMcpConsent(userId: string, id: string, send: () => Promise<void>) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='1s'");
    const user = await client.query('select id from "user" where id=$1 for share', [userId]);
    const consent = await client.query(
      `select id from "mcpAnalyticsConsent" where id=$1 and "userId"=$2 and enabled
       and "retiredAt" is null and "expiresAt">clock_timestamp() and "noticeVersion"=$3 for share`,
      [id, userId, MCP_NOTICE_VERSION],
    );
    if (user.rowCount && consent.rowCount) await send();
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function maintainMcpConsentRecords() {
  const client = await db.connect();
  try {
    await client.query("begin");
    const ended = (
      await client.query<{ id: string; enabled: boolean; userId: string | null }>(
        `select id,enabled,"userId" from "mcpAnalyticsConsent" where "retiredAt" is null
         and ("expiresAt"<=clock_timestamp() or "noticeVersion"<>$1)
         order by "expiresAt" for update skip locked limit 100`,
        [MCP_NOTICE_VERSION],
      )
    ).rows;
    for (const row of ended) {
      if (row.enabled && row.userId) await queueErasure(client, row.id, "mcp-consent-expired");
      await client.query('update "mcpAnalyticsConsent" set "retiredAt"=now() where id=$1', [
        row.id,
      ]);
    }
    await client.query(
      `delete from "mcpAnalyticsConsent" where "createdAt"<now()-interval '1 year' and "retiredAt" is not null`,
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
