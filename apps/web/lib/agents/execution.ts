import { admitAgentMessage, admitAgentOperation, admitAgentResult } from "./history-limits";
import "server-only";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { inDatabaseScope } from "@/lib/database-scope";
import {
  agentTransaction,
  appendMessage,
  appendThreadEvent,
  membership,
  validateTargets,
} from "./store";
import { AgentError, type StartRun } from "./protocol";
import { agentTools, checkToolScope, filterDiscovery } from "./tools";
import type { ExecutionRequest, ExecutionRun, ExecutionWorker } from "./execution-protocol";

type Run = {
  id: string;
  threadId: string;
  ownerId: string;
  organizationId: string;
  ownerName: string;
  allowOrganizationChanges?: boolean;
  generation: number;
  model: string;
  agentLimit: number;
  status: string;
  validLease: boolean;
};
class RejectedTool extends Error {
  constructor(readonly result: unknown) {
    super("Tool rejected the request.");
  }
}
const leaseSeconds = 45;
async function lockRun(
  client: PoolClient,
  id: string,
  generation: number,
  productAdmission = false,
): Promise<Run> {
  const run = (
    await client.query<Run>(
      `select r.*,t."organizationId",u."name" as "ownerName",r."leaseExpiresAt">now() as "validLease" from "agentRun" r join "agentThread" t on t."id"=r."threadId" join "user" u on u."id"=r."ownerId" where r."id"=$1 for update of r`,
      [id],
    )
  ).rows[0];
  if (
    !run ||
    run.generation !== generation ||
    !run.validLease ||
    !["running", "waiting"].includes(run.status)
  )
    throw new AgentError("lease_lost", "Run has stopped or its execution lease has ended.", 409);
  // Shared product services take this quota lock before user/member/file locks.
  // The enclosing tool must preserve that order before checking/locking its scope.
  if (productAdmission)
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      run.organizationId,
    ]);
  await membership(client, run.ownerId, run.organizationId, true);
  const connection = await client.query(
    `select 1 from "agentConnection" c join "agentRun" r on r."connectionId"=c."id" where r."id"=$1 and c."userId"=r."ownerId" and c."status"='connected' and c."provider"='codex' for share of c`,
    [id],
  );
  if (!connection.rowCount)
    throw new AgentError("connection_required", "Connect Codex again to continue.", 409);
  return run;
}
async function scope(client: PoolClient, run: Run): Promise<StartRun["files"]> {
  const row = (
    await client.query<{ files: StartRun["files"]; allowOrganizationChanges: boolean }>(
      `select "payload"->'files' as files,("payload"->>'allowOrganizationChanges')::boolean as "allowOrganizationChanges" from "agentEvent" where "threadId"=$1 and "type"='run.created' and "payload"->>'runId'=$2 order by "sequence" limit 1`,
      [run.threadId, run.id],
    )
  ).rows[0];
  if (!row?.files?.length) throw new AgentError("scope_missing", "Run scope is unavailable.", 409);
  run.allowOrganizationChanges = row.allowOrganizationChanges === true;
  const created = (
    await client.query<{ id: string }>(
      `select "payload"->>'fileId' as id from "agentEvent" where "threadId"=$1 and "type"='run.file.created' and "payload"->>'runId'=$2`,
      [run.threadId, run.id],
    )
  ).rows;
  const files = [
    ...row.files,
    ...created
      .filter((file) => !row.files.some((existing) => existing.id === file.id))
      .map((file) => ({ id: file.id, selectedNodeIds: [] })),
  ];
  await validateTargets(client, run.organizationId, files);
  return files;
}
async function worker(client: PoolClient, run: Run, id: string) {
  const row = (
    await client.query<ExecutionWorker & { status: string }>(
      `select "id","parentId","name","task","runtimeThreadId","status" from "agentWorker" where "id"=$1 and "runId"=$2`,
      [id, run.id],
    )
  ).rows[0];
  if (!row || !["queued", "working", "waiting"].includes(row.status))
    throw new AgentError("worker_inactive", "This agent is no longer working.", 409);
  return row;
}
async function failRun(client: PoolClient, run: Pick<Run, "id" | "threadId">, reason: string) {
  await client.query(
    `update "agentRun" set "status"='failed',"reason"=$2,"generation"="generation"+1,"leaseOwner"=null,"leaseExpiresAt"=null,"finishedAt"=now() where "id"=$1`,
    [run.id, reason],
  );
  await client.query(
    `update "agentWorker" set "status"='failed',"heartbeatAt"=null where "runId"=$1 and "status" in ('queued','working','waiting')`,
    [run.id],
  );
  await client.query(
    `update "agentMessage" set "delivery"='interrupted' where "runId"=$1 and "delivery"='pending'`,
    [run.id],
  );
  await appendThreadEvent(client, run.threadId, "run.failed", { runId: run.id, reason });
}
export async function claimExecution(runnerId: string): Promise<ExecutionRun | null> {
  return agentTransaction(async (client) => {
    // Admission is short and serial across processes. Reserve the selected cap,
    // so child spawning cannot race past per-owner/organisation limits.
    await client.query(`select pg_advisory_xact_lock(68492105)`);
    const expired = (
      await client.query<Run>(
        `select "id","threadId" from "agentRun" where "status" in ('running','waiting') and "leaseExpiresAt"<now() for update skip locked`,
      )
    ).rows;
    for (const run of expired) await failRun(client, run, "runner_disconnected");
    const candidates = (
      await client.query<Run>(`select r.*,t."organizationId" from "agentRun" r join "agentThread" t on t."id"=r."threadId"
      where r."status"='queued' and not exists(select 1 from "agentRun" limited where limited."ownerId"=r."ownerId" and limited."status"='limited') order by r."createdAt",r."id" limit 36 for update of r skip locked`)
    ).rows;
    for (const run of candidates) {
      let authorized = true;
      try {
        await membership(client, run.ownerId, run.organizationId, true);
      } catch (error) {
        if (!(error instanceof AgentError)) throw error;
        authorized = false;
      }
      const connected = await client.query(
        `select 1 from "agentConnection" c join "agentRun" r on r."connectionId"=c."id"
         where r."id"=$1 and c."userId"=r."ownerId" and c."status"='connected' and c."provider"='codex' for share of c`,
        [run.id],
      );
      if (!authorized || !connected.rowCount) {
        await failRun(client, run, "connection_or_access_lost");
        continue;
      }
      let files: StartRun["files"];
      try {
        files = await scope(client, run);
      } catch (error) {
        if (!(error instanceof AgentError)) throw error;
        await failRun(client, run, "target_unavailable");
        continue;
      }
      const counts = (
        await client.query<{ userCount: number; orgCount: number }>(
          `select coalesce(sum(r."agentLimit") filter(where r."ownerId"=$1),0)::int as "userCount",coalesce(sum(r."agentLimit") filter(where t."organizationId"=$2),0)::int as "orgCount"
        from "agentRun" r join "agentThread" t on t."id"=r."threadId" where r."status" in ('running','waiting')`,
          [run.ownerId, run.organizationId],
        )
      ).rows[0];
      if (counts.userCount + run.agentLimit > 12 || counts.orgCount + run.agentLimit > 36) continue;
      const claimed = (
        await client.query<{ generation: number }>(
          `update "agentRun" set "status"='running',"generation"="generation"+1,"leaseOwner"=$2,"leaseExpiresAt"=now()+$3*interval '1 second' where "id"=$1 returning "generation"`,
          [run.id, runnerId, leaseSeconds],
        )
      ).rows[0];
      await appendThreadEvent(client, run.threadId, "run.started", { runId: run.id });
      const workers = (
        await client.query<ExecutionWorker>(
          `select "id","parentId","name","task","runtimeThreadId" from "agentWorker" where "runId"=$1 order by "parentId" nulls first`,
          [run.id],
        )
      ).rows;
      const messages = (
        await client.query<ExecutionRun["messages"][number]>(
          `select m."kind",m."content",coalesce(u."name",w."name",'Tidy') as "authorName" from "agentMessage" m
        left join "user" u on u."id"=m."userId" left join "agentWorker" w on w."id"=m."agentId"
        where m."threadId"=$1 and (w."parentId" is null) and m."delivery"='delivered' order by m."sequence" desc limit 40`,
          [run.threadId],
        )
      ).rows.reverse();
      return {
        id: run.id,
        threadId: run.threadId,
        organizationId: run.organizationId,
        generation: claimed.generation,
        owner: createHmac("sha256", process.env.AGENT_RUNNER_SECRET!)
          .update(`tidy:runner:owner:${run.ownerId}`)
          .digest("hex"),
        model: run.model,
        agentLimit: run.agentLimit,
        allowOrganizationChanges: run.allowOrganizationChanges === true,
        files,
        workers,
        messages,
        tools: agentTools(
          run.ownerId,
          workers[0].id,
          "Lead",
          undefined,
          undefined,
          run.allowOrganizationChanges,
        ).tools,
      };
    }
    return null;
  });
}

export async function executeRequest(input: Exclude<ExecutionRequest, { action: "claim" }>) {
  let committed: (() => Promise<void>) | undefined;
  const result = await agentTransaction(async (client) => {
    const run = await lockRun(client, input.runId, input.generation, input.action === "tool");
    const files = await scope(client, run);
    if (input.action === "heartbeat") {
      await client.query(
        `update "agentRun" set "leaseExpiresAt"=now()+$2*interval '1 second' where "id"=$1`,
        [run.id, leaseSeconds],
      );
      await client.query(
        `update "agentWorker" set "heartbeatAt"=now() where "runId"=$1 and "status"='working'`,
        [run.id],
      );
      return { status: run.status };
    }
    if (input.action === "instructions") {
      if (input.delivered.length) {
        await client.query(
          `update "agentMessage" set "delivery"='delivered' where "runId"=$1 and "id"=any($2::uuid[]) and "delivery"='pending'`,
          [run.id, input.delivered],
        );
        await appendThreadEvent(client, run.threadId, "instructions.delivered", {
          ids: input.delivered,
        });
      }
      return {
        messages: (
          await client.query<{ id: string; content: string }>(
            `select "id","content" from "agentMessage" where "runId"=$1 and "delivery"='pending' order by "sequence" limit 100`,
            [run.id],
          )
        ).rows,
      };
    }
    if (input.action === "finish") {
      // Complete only after all outstanding instructions have been consumed.
      const pending = await client.query(
        `select 1 from "agentMessage" where "runId"=$1 and "delivery"='pending'`,
        [run.id],
      );
      if (input.status === "completed" && pending.rowCount) return { pending: true };
      const active = await client.query(
        `select 1 from "agentWorker" where "runId"=$1 and "parentId" is not null and "status" in ('queued','working','waiting')`,
        [run.id],
      );
      if (input.status === "completed" && active.rowCount)
        throw new AgentError("workers_active", "Wait for workers before completing.", 409);
      await client.query(
        `update "agentRun" set "status"=$2,"reason"=$3,"finishedAt"=case when $2 in ('completed','failed') then now() else null end,"leaseExpiresAt"=case when $2='waiting' then "leaseExpiresAt" else null end where "id"=$1`,
        [run.id, input.status, input.reason],
      );
      await client.query(
        `update "agentWorker" set "status"=$2,"heartbeatAt"=null where "runId"=$1 and "status" in ('queued','working','waiting')`,
        [
          run.id,
          input.status === "completed"
            ? "completed"
            : input.status === "waiting"
              ? "waiting"
              : "failed",
        ],
      );
      if (input.status !== "waiting")
        await client.query(
          `update "agentMessage" set "delivery"='interrupted' where "runId"=$1 and "delivery"='pending'`,
          [run.id],
        );
      if (input.reason === "connection_required")
        await client.query(
          `update "agentConnection" c set "status"='reconnect',"updatedAt"=now() from "agentRun" r where r."id"=$1 and c."id"=r."connectionId" and c."status"='connected'`,
          [run.id],
        );
      await appendThreadEvent(client, run.threadId, "run.finished", {
        runId: run.id,
        status: input.status,
        reason: input.reason,
      });
      return { pending: false };
    }
    const agent = await worker(client, run, input.agentId);
    if (input.action === "bind") {
      if (agent.runtimeThreadId && agent.runtimeThreadId !== input.runtimeThreadId)
        throw new AgentError("thread_bound", "Agent already has a runtime thread.", 409);
      await client.query(
        `update "agentWorker" set "runtimeThreadId"=$2,"status"='working',"heartbeatAt"=now() where "id"=$1`,
        [agent.id, input.runtimeThreadId],
      );
      await appendThreadEvent(client, run.threadId, "agent.working", { agentId: agent.id });
      return {};
    }
    if (input.action === "worker") {
      await client.query(
        `update "agentWorker" set "status"=$2,"heartbeatAt"=case when $2='working' then now() else null end where "id"=$1`,
        [agent.id, input.status],
      );
      if (!agent.parentId && ["waiting", "working"].includes(input.status))
        await client.query(`update "agentRun" set "status"=$2 where "id"=$1`, [
          run.id,
          input.status === "waiting" ? "waiting" : "running",
        ]);
      await appendThreadEvent(client, run.threadId, "agent.status", {
        agentId: agent.id,
        status: input.status,
      });
      return {};
    }
    if (input.action === "message") {
      const prior = (
        await client.query<{ agentId: string; runId: string }>(
          `select "agentId","runId" from "agentMessage" where "id"=$1`,
          [input.id],
        )
      ).rows[0];
      if (prior && (prior.agentId !== agent.id || prior.runId !== run.id))
        throw new AgentError("message_reused", "Message ID belongs to another agent.", 409);
      if (prior) {
        await admitAgentMessage(client, run.id, input.content, input.id);
        await client.query(`update "agentMessage" set "content"=$2 where "id"=$1`, [
          input.id,
          input.content,
        ]);
        await appendThreadEvent(client, run.threadId, "message.updated", { id: input.id });
      } else
        await appendMessage(client, {
          id: input.id,
          threadId: run.threadId,
          runId: run.id,
          agentId: agent.id,
          kind: input.kind,
          content: input.content,
        });
      return {};
    }
    const hash = createHash("sha256")
      .update(
        JSON.stringify(
          input.action === "tool" ? [input.tool, input.arguments] : [input.name, input.task],
        ),
      )
      .digest("hex");
    const prior = (
      await client.query<{ inputHash: string; agentId: string; result: unknown }>(
        `select "inputHash","agentId","result" from "agentToolOperation" where "runId"=$1 and "callId"=$2`,
        [run.id, input.callId],
      )
    ).rows[0];
    if (prior) {
      if (prior.inputHash !== hash || prior.agentId !== agent.id)
        throw new AgentError("call_reused", "Tool call ID belongs to different work.", 409);
      return prior.result;
    }
    await admitAgentOperation(client, run.id);
    let output: unknown;
    if (input.action === "spawn") {
      if (agent.parentId)
        throw new AgentError("spawn_denied", "Only the lead can assign workers.", 403);
      const count = (
        await client.query<{ count: number }>(
          `select count(*)::int as count from "agentWorker" where "runId"=$1`,
          [run.id],
        )
      ).rows[0].count;
      if (count >= run.agentLimit)
        throw new AgentError("agent_limit", "This run has reached its selected agent count.", 409);
      const id = randomUUID();
      await client.query(
        `insert into "agentWorker" ("id","runId","parentId","name","task","fileId") values ($1,$2,$3,$4,$5,$6)`,
        [id, run.id, agent.id, input.name, input.task, files[0].id],
      );
      await appendThreadEvent(client, run.threadId, "agent.created", {
        agentId: id,
        name: input.name,
      });
      output = {
        id,
        parentId: agent.id,
        name: input.name,
        task: input.task,
        runtimeThreadId: null,
      } satisfies ExecutionWorker;
    } else {
      await checkToolScope(
        client,
        run.ownerId,
        run.organizationId,
        files,
        input.tool,
        input.arguments,
        run.id,
        run.allowOrganizationChanges,
      );
      // Hold current membership and target rows until commit. Removal, archival,
      // moving files, Stop and duplicate calls all serialize with this commit.
      await client.query(
        `select "id" from "member" where "userId"=$1 and "organizationId"=$2 for share`,
        [run.ownerId, run.organizationId],
      );
      await client.query(
        `select "id" from "designFile" where "id"=any($1::text[]) order by "id" for no key update`,
        [files.map((file) => file.id)],
      );
      await validateTargets(client, run.organizationId, files);
      await membership(client, run.ownerId, run.organizationId, true);
      const registered = agentTools(
        run.ownerId,
        agent.id,
        agent.name,
        run.threadId,
        run.ownerName,
        run.allowOrganizationChanges,
      );
      await client.query("savepoint tidy_tool");
      try {
        const work = await inDatabaseScope(client, async () =>
          registered.activity.run(input.tool, input.arguments, async () => {
            const value = filterDiscovery(
              await registered.invoke(input.tool, input.arguments),
              input.tool,
              run.organizationId,
              files,
            );
            if (value.isError) throw new RejectedTool(value);
            return value;
          }),
        );
        committed = work.afterCommit;
        output = work.value;
        await client.query("release savepoint tidy_tool");
      } catch (error) {
        await client.query("rollback to savepoint tidy_tool");
        if (!(error instanceof RejectedTool)) throw error;
        output = error.result;
      }
    }
    const serialized = JSON.stringify(output);
    await admitAgentResult(client, run.id, serialized);
    if (
      input.action === "tool" &&
      run.allowOrganizationChanges &&
      ["create_file", "commit_import", "import_web_capture"].includes(input.tool)
    ) {
      const data = (output as { structuredContent?: { fileId?: string; file?: { id?: string } } })
        ?.structuredContent;
      const id = data?.fileId ?? data?.file?.id;
      if (id && !files.some((file) => file.id === id)) {
        await validateTargets(client, run.organizationId, [{ id, selectedNodeIds: [] }]);
        await client.query(
          `insert into "agentThreadFile" ("threadId","fileId") values ($1,$2) on conflict do nothing`,
          [run.threadId, id],
        );
        await appendThreadEvent(client, run.threadId, "run.file.created", {
          runId: run.id,
          fileId: id,
        });
      }
    }
    await client.query(
      `insert into "agentToolOperation" ("runId","callId","agentId","tool","inputHash","result","status") values ($1,$2,$3,$4,$5,$6::jsonb,'completed')`,
      [
        run.id,
        input.callId,
        agent.id,
        input.action === "tool" ? input.tool : "tidy_spawn_agent",
        hash,
        serialized,
      ],
    );
    return output;
  });
  await committed?.();
  return result;
}
