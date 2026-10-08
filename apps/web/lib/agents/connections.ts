import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { reservePersonalAttempts } from "@/lib/security/personal-budget";
import { lockAgentUser, verifiedAgentUser, withAgentDisconnectLock } from "./personal-authority";
import { db } from "@/lib/db";
import { chatgptConfigured } from "./config";
import { activeRunStatuses, AgentError, planHelpUrl, type ConnectionStatus } from "./protocol";
import { runnerConfigured, runnerRequest } from "./runner-client";
import { agentTransaction, appendThreadEvent } from "./store";

const accountResponse = z.object({
  account: z
    .object({
      type: z.string().min(1).max(100),
      email: z.string().max(254).nullish(),
      planType: z.string().max(100).nullish(),
    })
    .nullable(),
});
export type NativeLogin = {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
};
export async function connectionStatus(userId: string): Promise<ConnectionStatus> {
  await verifiedAgentUser(db, userId);
  await reservePersonalAttempts("agent-status", userId);
  return statusForUser(userId);
}
async function statusForUser(userId: string): Promise<ConnectionStatus> {
  const row = (
    await db.query<{
      provider: ConnectionStatus["provider"];
      status: ConnectionStatus["status"];
      accountLabel: string;
    }>(
      `select c."provider",c."status",c."accountLabel" from "user" u left join "agentConnection" c on c."userId"=u."id" where u."id"=$1 and u."emailVerified"=true`,
      [userId],
    )
  ).rows[0];
  if (!row)
    throw new AgentError(
      "access_denied",
      "Account access denied. Sign in with a verified email.",
      403,
    );
  return {
    configured: runnerConfigured(),
    planSharingConfigured: chatgptConfigured(),
    provider: row?.provider ?? "codex",
    status: row?.status ?? "disconnected",
    accountLabel: row?.accountLabel || null,
    usageUrl:
      row?.provider === "chatgpt" ? planHelpUrl : "https://chatgpt.com/codex/settings/usage",
    helpUrl: planHelpUrl,
  };
}
export async function startNativeLogin(userId: string): Promise<NativeLogin> {
  await verifiedAgentUser(db, userId);
  await reservePersonalAttempts("agent-login", userId);
  if (!runnerConfigured())
    throw new AgentError("not_configured", "Codex connections are not available yet.", 503);
  // Serialize against run admission and disconnect. Never switch auth beneath an
  // active run, including a queued or allowance-limited run.
  return agentTransaction(async (client) => {
    await lockAgentUser(client, userId);
    const active = await client.query(
      `select 1 from "agentRun" where "ownerId"=$1 and "status"=any($2::text[])`,
      [userId, activeRunStatuses],
    );
    if (active.rowCount)
      throw new AgentError(
        "run_active",
        "Stop your active runs before changing the connected account.",
        409,
      );
    const login = await runnerRequest<NativeLogin>(userId, "login");
    if (
      login.type !== "chatgptDeviceCode" ||
      typeof login.loginId !== "string" ||
      !login.loginId ||
      login.loginId.length > 200 ||
      typeof login.userCode !== "string" ||
      !/^[A-Z0-9-]{4,32}$/.test(login.userCode) ||
      login.verificationUrl !== "https://auth.openai.com/codex/device"
    ) {
      throw new AgentError("login_failed", "Codex did not return a supported sign-in flow.", 502);
    }
    await client.query(
      `insert into "agentConnection" ("id","userId","provider","subject","clientId","accountLabel","status") values ($1,$2,'codex','','codex-managed','','connecting')
      on conflict ("userId") do update set "provider"='codex',"subject"='',"clientId"='codex-managed',"accountLabel"='',"status"='connecting',"encryptedTokens"=null,"scopes"='{}',"version"="agentConnection"."version"+1,"updatedAt"=now()`,
      [randomUUID(), userId],
    );
    return login;
  });
}
export async function refreshNativeConnection(userId: string) {
  await verifiedAgentUser(db, userId);
  await reservePersonalAttempts("agent-refresh", userId);
  const connection = (
    await db.query<{ id: string; version: number; status: string }>(
      `select c."id",c."version",c."status" from "agentConnection" c join "user" u on u."id"=c."userId" and u."emailVerified"=true where c."userId"=$1 and c."provider"='codex'`,
      [userId],
    )
  ).rows[0];
  if (!connection || connection.status === "disconnected") return statusForUser(userId);
  const result = accountResponse.safeParse(await runnerRequest<unknown>(userId, "account"));
  if (!result.success)
    throw new AgentError("runner_error", "Codex did not return a supported account response.", 502);
  const supported = result.data.account?.type === "chatgpt";
  const status = supported
    ? "connected"
    : connection.status === "connecting"
      ? "connecting"
      : "reconnect";
  await agentTransaction(async (client) => {
    await lockAgentUser(client, userId);
    await client.query(
      `update "agentConnection" set "status"=$3,"accountLabel"=$4,"updatedAt"=now()
    where "id"=$1 and "version"=$2 and "status"<>'disconnected'`,
      [
        connection.id,
        connection.version,
        status,
        supported ? (result.data.account?.email ?? "Codex account").slice(0, 254) : "",
      ],
    );
  });
  return statusForUser(userId);
}
export async function disconnectAgentConnection(userId: string) {
  await verifiedAgentUser(db, userId);
  await reservePersonalAttempts("agent-disconnect", userId);
  return withAgentDisconnectLock(userId, async () => {
    await agentTransaction(async (client) => {
      await verifiedAgentUser(client, userId, true);

      const runs = (
        await client.query<{ id: string; threadId: string }>(
          `update "agentRun" set "status"='cancelled',"reason"='disconnected',"generation"="generation"+1,"leaseOwner"=null,"leaseExpiresAt"=null,"finishedAt"=now()
      where "ownerId"=$1 and "status"=any($2::text[]) returning "id","threadId"`,
          [userId, activeRunStatuses],
        )
      ).rows;
      for (const run of runs) {
        await client.query(
          `update "agentWorker" set "status"='cancelled',"heartbeatAt"=null where "runId"=$1 and "status" in ('queued','working','waiting')`,
          [run.id],
        );
        await client.query(
          `update "agentMessage" set "delivery"='interrupted' where "runId"=$1 and "delivery"='pending'`,
          [run.id],
        );
        await appendThreadEvent(client, run.threadId, "run.stopped", {
          runId: run.id,
          reason: "disconnected",
        });
      }
      await client.query(
        `update "agentConnection" set "status"='disconnected',"encryptedTokens"=null,"scopes"='{}',"accountLabel"='',"version"="version"+1,"updatedAt"=now() where "userId"=$1`,
        [userId],
      );
    });
    // The durable fence takes effect even when the process host cannot be reached.
    // Reconnection needs a fresh, deliberate login; background polling cannot undo it.
    try {
      await runnerRequest(userId, "logout");
    } catch {
      /* Runner reconciles disconnected accounts before executing. */
    }
  });
}
