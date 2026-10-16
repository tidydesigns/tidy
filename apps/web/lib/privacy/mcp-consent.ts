import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { PrivacyError } from "./access";
import type { PoolClient } from "pg";

import { MCP_NOTICE_VERSION } from "./consent";
export const mcpAnalyticsId = (consentId: string) => `mcp:${consentId}`;

// This is an account choice, never inferred from OAuth grants or browser cookies.
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

export async function setMcpConsent(userId: string, sessionId: string, enabled: boolean) {
  const client = await db.connect();
  try {
    await client.query("begin");
    // Serialize account changes with delivery and account deletion. Never hold
    // this lock while an MCP tool itself executes.
    const user = await client.query('select id from "user" where id=$1 for update', [userId]);
    const session = await client.query(
      `select id from session where id=$1 and "userId"=$2 and "expiresAt">clock_timestamp() for share`,
      [sessionId, userId],
    );
    if (!user.rowCount || !session.rowCount)
      throw new PrivacyError("Sign in to change your privacy choices.", 401, "SESSION_REQUIRED");
    const previous = (
      await client.query<{ id: string; enabled: boolean; current: boolean }>(
        `select id,enabled,("expiresAt">clock_timestamp() and "noticeVersion"=$2) as current
         from "mcpAnalyticsConsent" where "userId"=$1 and "retiredAt" is null for update`,
        [userId, MCP_NOTICE_VERSION],
      )
    ).rows[0];
    if (previous && previous.enabled === enabled && previous.current) {
      await client.query("commit");
      return { enabled };
    }
    if (previous) {
      if (previous.enabled) await queueErasure(client, previous.id, "mcp-consent-ended");
      await client.query('update "mcpAnalyticsConsent" set "retiredAt"=now() where id=$1', [
        previous.id,
      ]);
    }
    await client.query(
      `insert into "mcpAnalyticsConsent" (id,"userId",enabled,"noticeVersion","expiresAt")
       values ($1,$2,$3,$4,clock_timestamp()+interval '90 days')`,
      [randomUUID(), userId, enabled, MCP_NOTICE_VERSION],
    );
    await client.query("commit");
    return { enabled };
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
      await client.query<{ id: string; enabled: boolean }>(
        `select id,enabled from "mcpAnalyticsConsent" where "retiredAt" is null
         and ("expiresAt"<=clock_timestamp() or "noticeVersion"<>$1)
         order by "expiresAt" for update skip locked limit 100`,
        [MCP_NOTICE_VERSION],
      )
    ).rows;
    for (const row of ended) {
      if (row.enabled) await queueErasure(client, row.id, "mcp-consent-expired");
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
