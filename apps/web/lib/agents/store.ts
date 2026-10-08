import { lockAgentUser } from "./personal-authority";
import { EDIT_ROLES_SQL, VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import { admitAgentMessage } from "./history-limits";
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "@/lib/db";
import { can } from "@/lib/organizations/roles";
import {
  AgentError,
  activeRunStatuses,
  startRunSchema,
  instructionSchema,
  type AgentMessage,
  type AgentRun,
  type AgentWorker,
  type StartRun,
  type ThreadEvent,
  type ThreadSnapshot,
  type ThreadSummary,
} from "./protocol";

export const AGENT_HISTORY_LIMITS = {
  events: 1000,
  threads: 500,
  runs: 5000,
  threadRuns: 100,
  userStartsPerHour: 30,
  workspaceStartsPerHour: 150,
} as const;

export async function agentTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
export async function agentsSchemaReady() {
  const result = await db.query<{ ready: boolean }>(
    `select to_regclass('public."agentThread"') is not null as ready`,
  );
  return result.rows[0]?.ready === true;
}
export async function membership(
  client: Pick<PoolClient, "query">,
  userId: string,
  organizationId: string,
  edit = false,
) {
  const result = await client.query<{ role: string }>(
    `select m."role" from "member" m join "user" u on u."id"=m."userId" and u."emailVerified"=true
     where m."userId"=$1 and m."organizationId"=$2 and m."role" in ${edit ? EDIT_ROLES_SQL : VIEW_ROLES_SQL}
     ${client !== db ? "for share of m,u" : ""}`,
    [userId, organizationId],
  );
  if (result.rows.length !== 1)
    throw new AgentError("access_denied", "Thread not found or access denied.", 403);
  return result.rows[0]!.role;
}
export async function threadAccess(
  client: Pick<PoolClient, "query">,
  userId: string,
  threadId: string,
  edit = false,
) {
  const thread = (
    await client.query<{ id: string; organizationId: string; title: string; sequence: string }>(
      `select "id","organizationId","title","sequence" from "agentThread" where "id"=$1 ${client !== db ? (edit ? "for no key update" : "for share") : ""}`,
      [threadId],
    )
  ).rows[0];
  if (!thread) throw new AgentError("not_found", "Thread not found or access denied.", 404);
  const role = await membership(client, userId, thread.organizationId, edit);
  return { ...thread, role };
}
export async function appendThreadEvent(
  client: PoolClient,
  threadId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  const row = (
    await client.query<{ sequence: string }>(
      `update "agentThread" set "sequence"="sequence"+1,"updatedAt"=now() where "id"=$1 returning "sequence"`,
      [threadId],
    )
  ).rows[0];
  if (!row) throw new AgentError("not_found", "Thread no longer exists.", 404);
  await client.query(
    `insert into "agentEvent" ("threadId","sequence","type","payload") values ($1,$2,$3,$4::jsonb)`,
    [threadId, row.sequence, type, JSON.stringify(payload)],
  );
  // Polling events are invalidations, not the conversation or run authority.
  // Keep immutable scope events: execution reads them for every tool call.
  await client.query(
    `delete from "agentEvent" where "threadId"=$1 and "sequence" in (
    select "sequence" from "agentEvent" where "threadId"=$1 and "type" not in ('run.created','run.file.created')
    order by "sequence" desc offset $2
  )`,
    [threadId, AGENT_HISTORY_LIMITS.events],
  );
  return Number(row.sequence);
}
type MessageInput = {
  id?: string;
  threadId: string;
  runId: string;
  agentId?: string;
  userId?: string;
  kind: AgentMessage["kind"];
  content: string;
  delivery?: AgentMessage["delivery"];
  requestId?: string;
};
export async function appendMessage(client: PoolClient, input: MessageInput) {
  await admitAgentMessage(client, input.runId, input.content);
  const id = input.id ?? randomUUID();
  const sequence = await appendThreadEvent(client, input.threadId, "message", {
    id,
    runId: input.runId,
  });
  await client.query(
    `insert into "agentMessage" ("id","threadId","runId","agentId","userId","kind","content","delivery","requestId","sequence")
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      input.threadId,
      input.runId,
      input.agentId ?? null,
      input.userId ?? null,
      input.kind,
      input.content,
      input.delivery ?? "delivered",
      input.requestId ?? null,
      sequence,
    ],
  );
  return id;
}
export async function validateTargets(
  client: Pick<PoolClient, "query">,
  organizationId: string,
  files: StartRun["files"],
) {
  const rows = (
    await client.query<{ id: string }>(
      `select "id" from "designFile" where "organizationId"=$1 and "id"=any($2::text[]) and "archivedAt" is null`,
      [organizationId, files.map((file) => file.id)],
    )
  ).rows;
  if (rows.length !== files.length)
    throw new AgentError("invalid_target", "Choose active files from this organisation.", 403);
}

export async function startAgentRun(userId: string, raw: unknown, model: string) {
  const input = startRunSchema.parse(raw);
  const hash = createHash("sha256")
    .update(JSON.stringify({ ...input, model }))
    .digest("hex");
  return agentTransaction(async (client) => {
    // Product quota locks precede retained actor/membership locks. The personal
    // advisory fence serializes admission and account changes across workspaces.
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      input.organizationId,
    ]);
    await lockAgentUser(client, userId);
    await client.query(`select "id" from "organization" where "id"=$1 for no key update`, [
      input.organizationId,
    ]);
    await membership(client, userId, input.organizationId, true);
    const prior = (
      await client.query<{ id: string; threadId: string; requestHash: string }>(
        `select "id","threadId","requestHash" from "agentRun" where "ownerId"=$1 and "requestId"=$2`,
        [userId, input.requestId],
      )
    ).rows[0];
    if (prior) {
      if (prior.requestHash !== hash)
        throw new AgentError(
          "request_reused",
          "This request was already used for different work.",
          409,
        );
      await threadAccess(client, userId, prior.threadId);
      return { runId: prior.id, threadId: prior.threadId };
    }
    const history = (
      await client.query<{
        threads: number;
        runs: number;
        threadRuns: number;
        userRecent: number;
        workspaceRecent: number;
      }>(
        `select
      (select count(*)::int from "agentThread" where "organizationId"=$1) as threads,
      count(*)::int as runs, count(*) filter (where r."threadId"=$2)::int as "threadRuns",
      count(*) filter (where r."ownerId"=$3 and r."createdAt">now()-interval '1 hour')::int as "userRecent",
      count(*) filter (where r."createdAt">now()-interval '1 hour')::int as "workspaceRecent"
      from "agentRun" r join "agentThread" t on t."id"=r."threadId" where t."organizationId"=$1`,
        [input.organizationId, input.threadId ?? null, userId],
      )
    ).rows[0];
    if (
      (!input.threadId && history.threads >= AGENT_HISTORY_LIMITS.threads) ||
      history.runs >= AGENT_HISTORY_LIMITS.runs ||
      history.threadRuns >= AGENT_HISTORY_LIMITS.threadRuns
    ) {
      throw new AgentError(
        "history_limit",
        "This workspace or thread has reached its agent history limit.",
        409,
      );
    }
    if (
      history.userRecent >= AGENT_HISTORY_LIMITS.userStartsPerHour ||
      history.workspaceRecent >= AGENT_HISTORY_LIMITS.workspaceStartsPerHour
    ) {
      throw new AgentError(
        "run_rate_limit",
        "Too many agent runs have been started. Try again later.",
        429,
      );
    }
    await validateTargets(client, input.organizationId, input.files);
    const connection = (
      await client.query<{ id: string }>(
        `select "id" from "agentConnection" where "userId"=$1 and "status"='connected' and ("provider"='codex' or "encryptedTokens" is not null) for update`,
        [userId],
      )
    ).rows[0];
    if (!connection)
      throw new AgentError(
        "connection_required",
        "Connect your Codex account before starting a run.",
        409,
      );
    const threadId = input.threadId ?? randomUUID();
    if (input.threadId) {
      const thread = await threadAccess(client, userId, threadId, true);
      if (thread.organizationId !== input.organizationId)
        throw new AgentError("invalid_target", "Threads stay in their organisation.", 403);
      await client.query(`select "id" from "agentThread" where "id"=$1 for update`, [threadId]);
      const active = await client.query(
        `select 1 from "agentRun" where "threadId"=$1 and "status"=any($2::text[])`,
        [threadId, activeRunStatuses],
      );
      if (active.rowCount)
        throw new AgentError(
          "run_active",
          "This thread already has a run. Wait or stop it before sending another prompt.",
          409,
        );
    }
    // Bound queued work as well as active work; the scheduler separately admits
    // concurrent agents under the 12/user and 36/organisation execution caps.
    const queued = await client.query(
      `select 1 from "agentRun" where "ownerId"=$1 and "status"=any($2::text[])`,
      [userId, activeRunStatuses],
    );
    if ((queued.rowCount ?? 0) >= 3)
      throw new AgentError("run_limit", "You can run up to three threads at once.", 409);
    if (!input.threadId)
      await client.query(
        `insert into "agentThread" ("id","organizationId","createdBy","title") values ($1,$2,$3,$4)`,
        [threadId, input.organizationId, userId, input.prompt.slice(0, 120)],
      );
    // Scope grows explicitly when continuing a thread; history cannot secretly
    // introduce another organisation or grant a current run access to old files.
    for (const file of input.files)
      await client.query(
        `insert into "agentThreadFile" ("threadId","fileId","selectedNodeIds") values ($1,$2,$3)
      on conflict ("threadId","fileId") do update set "selectedNodeIds"=excluded."selectedNodeIds"`,
        [threadId, file.id, file.selectedNodeIds],
      );
    const runId = randomUUID();
    await client.query(
      `insert into "agentRun" ("id","threadId","ownerId","connectionId","requestId","requestHash","agentLimit","model") values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [runId, threadId, userId, connection.id, input.requestId, hash, input.agentLimit, model],
    );
    // Immutable run scope is persisted in the initial event, independent of later
    // thread attachments. The runner may only use these resources.
    await appendThreadEvent(client, threadId, "run.created", {
      runId,
      files: input.files,
      allowOrganizationChanges: input.allowOrganizationChanges,
      ownerId: userId,
      agentLimit: input.agentLimit,
    });
    await appendMessage(client, { threadId, runId, userId, kind: "user", content: input.prompt });
    await client.query(
      `insert into "agentWorker" ("id","runId","name","task","fileId") values ($1,$2,'Lead',$3,$4)`,
      [randomUUID(), runId, input.prompt, input.files[0].id],
    );
    return { runId, threadId };
  });
}

export async function stopAgentRun(userId: string, runId: string) {
  return agentTransaction(async (client) => {
    const run = (
      await client.query<{ threadId: string; ownerId: string; status: AgentRun["status"] }>(
        `select "threadId","ownerId","status" from "agentRun" where "id"=$1 for update`,
        [runId],
      )
    ).rows[0];
    if (!run) throw new AgentError("not_found", "Run not found.", 404);
    const thread = await threadAccess(client, userId, run.threadId);
    if (run.ownerId !== userId && !can(thread.role, "manage"))
      throw new AgentError(
        "access_denied",
        "Only the run owner or an administrator can stop this run.",
        403,
      );
    if (!activeRunStatuses.includes(run.status)) return;
    await client.query(
      `update "agentRun" set "status"='cancelled',"reason"='stopped',"generation"="generation"+1,"leaseOwner"=null,"leaseExpiresAt"=null,"finishedAt"=now() where "id"=$1`,
      [runId],
    );
    await client.query(
      `update "agentWorker" set "status"='cancelled',"heartbeatAt"=null where "runId"=$1 and "status" in ('queued','working','waiting')`,
      [runId],
    );
    await client.query(
      `update "agentMessage" set "delivery"='interrupted' where "runId"=$1 and "delivery"='pending'`,
      [runId],
    );
    await appendThreadEvent(client, run.threadId, "run.stopped", { runId, userId });
  });
}

export async function steerAgentRun(userId: string, runId: string, raw: unknown) {
  const input = instructionSchema.parse(raw);
  return agentTransaction(async (client) => {
    const run = (
      await client.query<{ threadId: string; ownerId: string; status: AgentRun["status"] }>(
        `select "threadId","ownerId","status" from "agentRun" where "id"=$1 for update`,
        [runId],
      )
    ).rows[0];
    if (!run) throw new AgentError("not_found", "Run not found.", 404);
    await threadAccess(client, userId, run.threadId, true);
    if (run.ownerId !== userId)
      throw new AgentError("access_denied", "Only the run owner can direct its agents.", 403);
    const prior = (
      await client.query<{ id: string; runId: string; content: string }>(
        `select "id","runId","content" from "agentMessage" where "userId"=$1 and "requestId"=$2`,
        [userId, input.requestId],
      )
    ).rows[0];
    if (prior) {
      if (prior.runId !== runId || prior.content !== input.content)
        throw new AgentError("request_reused", "This instruction ID was already used.", 409);
      return prior.id;
    }
    if (!["queued", "running", "waiting", "recovering"].includes(run.status))
      throw new AgentError("run_inactive", "This run is not accepting instructions.", 409);
    return appendMessage(client, {
      threadId: run.threadId,
      runId,
      userId,
      requestId: input.requestId,
      kind: "instruction",
      content: input.content,
      delivery: "pending",
    });
  });
}

export async function renameAgentThread(userId: string, threadId: string, title: string) {
  const cleaned = title.trim();
  if (!cleaned || cleaned.length > 120)
    throw new AgentError("invalid_title", "Use a title between 1 and 120 characters.");
  await agentTransaction(async (client) => {
    await threadAccess(client, userId, threadId, true);
    await client.query(`update "agentThread" set "title"=$2 where "id"=$1`, [threadId, cleaned]);
    await appendThreadEvent(client, threadId, "thread.renamed", { title: cleaned });
  });
}

export async function listAgentThreads(
  userId: string,
  organizationId: string,
  fileId?: string,
  before?: string,
): Promise<ThreadSummary[]> {
  await membership(db, userId, organizationId);
  let position: { timestamp: string; id: string; active: boolean } | undefined;
  if (before) {
    const [active, timestamp, id, ...extra] = Buffer.from(before, "base64url")
      .toString("utf8")
      .split("|");
    if (
      extra.length ||
      !["0", "1"].includes(active) ||
      !Number.isFinite(Date.parse(timestamp)) ||
      !/^[a-f0-9-]{36}$/.test(id)
    )
      throw new AgentError("invalid_cursor", "Invalid thread position.");
    position = { timestamp, id, active: active === "1" };
  }
  const result = await db.query<ThreadSummary>(
    `select t."id",t."organizationId",t."title",t."updatedAt"::text,t."sequence"::int,
    coalesce((select jsonb_agg(jsonb_build_object('id',f."id",'name',f."name",'selectedNodeIds',tf."selectedNodeIds") order by f."id")
      from "agentThreadFile" tf join "designFile" f on f."id"=tf."fileId" where tf."threadId"=t."id" and f."organizationId"=t."organizationId" and f."archivedAt" is null),'[]'::jsonb) as files,
    (select jsonb_build_object('id',r."id",'threadId',r."threadId",'ownerId',r."ownerId",'ownerName',u."name",'agentLimit',r."agentLimit",'model',r."model",'status',r."status",'reason',r."reason",'createdAt',r."createdAt",'finishedAt',r."finishedAt")
      from "agentRun" r join "user" u on u."id"=r."ownerId" where r."threadId"=t."id" order by r."createdAt" desc,r."id" desc limit 1) as run,
    (select count(*)::int from "agentWorker" w join "agentRun" r on r."id"=w."runId" where r."threadId"=t."id" and r."status"=any($5::text[]) and w."status"='working') as "activeAgents"
    from "agentThread" t join "member" actor on actor."organizationId"=t."organizationId" and actor."userId"=$8
    join "user" viewer on viewer."id"=actor."userId" and viewer."emailVerified"=true
    where actor."role" in ${VIEW_ROLES_SQL} and t."organizationId"=$1
      and ($2::text is null or exists(select 1 from "agentThreadFile" tf where tf."threadId"=t."id" and tf."fileId"=$2))
      and ($3::timestamptz is null or (exists(select 1 from "agentRun" ar where ar."threadId"=t."id" and ar."status"=any($5::text[])),t."updatedAt",t."id") < ($6::boolean,$3::timestamptz,$7::uuid))
    order by exists(select 1 from "agentRun" r where r."threadId"=t."id" and r."status"=any($5::text[])) desc,t."updatedAt" desc,t."id" desc limit $4`,
    [
      organizationId,
      fileId ?? null,
      position?.timestamp ?? null,
      50,
      activeRunStatuses,
      position?.active ?? false,
      position?.id ?? null,
      userId,
    ],
  );
  return result.rows.map((row) => ({
    ...row,
    cursor: Buffer.from(
      `${row.run && activeRunStatuses.includes(row.run.status) ? "1" : "0"}|${row.updatedAt}|${row.id}`,
    ).toString("base64url"),
  }));
}
export async function getAgentThread(
  userId: string,
  threadId: string,
  beforeSequence?: number,
): Promise<ThreadSnapshot> {
  // Every writer allocates its event sequence before committing. Retaining the
  // thread row prevents any intervening writer commit while children are read.
  return agentTransaction(async (client) => {
    const access = await threadAccess(client, userId, threadId);
    const base = (
      await client.query<{ updatedAt: string }>(
        `select "updatedAt"::text from "agentThread" where "id"=$1`,
        [threadId],
      )
    ).rows[0];
    const files = (
      await client.query<ThreadSummary["files"][number]>(
        `select f."id",f."name",tf."selectedNodeIds" from "agentThreadFile" tf join "designFile" f on f."id"=tf."fileId" where tf."threadId"=$1 and f."organizationId"=$2 and f."archivedAt" is null order by f."id"`,
        [threadId, access.organizationId],
      )
    ).rows;
    const run =
      (
        await client.query<AgentRun>(
          `select r."id",r."threadId",r."ownerId",u."name" as "ownerName",r."agentLimit",r."model",r."status",r."reason",r."createdAt"::text,r."finishedAt"::text
      from "agentRun" r join "user" u on u."id"=r."ownerId" where r."threadId"=$1 order by r."createdAt" desc,r."id" desc limit 1`,
          [threadId],
        )
      ).rows[0] ?? null;
    const messages = (
      await client.query<AgentMessage>(
        `select m."id",m."runId",m."agentId",m."userId",coalesce(u."name",w."name",'Tidy') as "authorName",(w."parentId" is not null) as "isWorker",m."kind",m."content",m."delivery",m."sequence"::int,m."createdAt"::text
      from "agentMessage" m left join "user" u on u."id"=m."userId" left join "agentWorker" w on w."id"=m."agentId"
      where m."threadId"=$1 and ($2::bigint is null or m."sequence"<$2) order by m."sequence" desc limit 101`,
        [threadId, beforeSequence ?? null],
      )
    ).rows;
    const workers = run
      ? (
          await client.query<AgentWorker>(
            `select "id","runId","parentId","name","task","status","fileId","nodeIds","heartbeatAt"::text from "agentWorker" where "runId"=$1 order by "parentId" nulls first,"id"`,
            [run.id],
          )
        ).rows
      : [];
    return {
      thread: {
        id: threadId,
        organizationId: access.organizationId,
        title: access.title,
        sequence: Number(access.sequence),
        updatedAt: base.updatedAt,
        files,
        run,
        activeAgents: workers.filter((worker) => worker.status === "working").length,
      },
      messages: messages.slice(0, 100).reverse(),
      hasOlder: messages.length > 100,
      workers,
    };
  });
}
export async function getThreadEvents(
  userId: string,
  threadId: string,
  after: number,
): Promise<ThreadEvent[]> {
  return agentTransaction(async (client) => {
    const thread = await threadAccess(client, userId, threadId);
    const events = (
      await client.query<ThreadEvent>(
        `select "sequence"::int,"type","payload" from "agentEvent" where "threadId"=$1 and "sequence">$2 order by "sequence" limit 200`,
        [threadId, after],
      )
    ).rows;
    if (
      (events.length && events[0].sequence > after + 1) ||
      (!events.length && Number(thread.sequence) > after)
    ) {
      return [
        {
          sequence: Math.max(Number(thread.sequence), events.at(-1)?.sequence ?? 0),
          type: "thread.invalidated",
          payload: {},
        },
      ];
    }
    return events;
  });
}
