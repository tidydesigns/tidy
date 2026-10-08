import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { db } from "../db";

mock.module("server-only", () => ({}));
const {
  agentTransaction,
  startAgentRun,
  getAgentThread,
  listAgentThreads,
  getThreadEvents,
  steerAgentRun,
  stopAgentRun,
  renameAgentThread,
} = await import("./store");
const { inDatabaseScope, withoutDatabaseScope } = await import("../database-scope");
const { claimExecution, executeRequest } = await import("./execution");
const { disconnectAgentConnection } = await import("./connections");
const url = process.env.AGENTS_TEST_DATABASE_URL,
  setupUrl = process.env.AGENTS_SETUP_DATABASE_URL;
let admin: Client;
const enabled = Boolean(
  url &&
  setupUrl &&
  new URL(setupUrl).hostname === "127.0.0.1" &&
  new URL(setupUrl).pathname === "/tidy_agents_test" &&
  new URL(url).port === new URL(setupUrl).port &&
  url === process.env.DATABASE_URL &&
  new URL(url).hostname === "127.0.0.1" &&
  new URL(url).pathname === "/tidy_agents_test",
);
const integration = enabled ? test : test.skip;
const files = [{ id: "file-a", selectedNodeIds: [] }];
const input = () => ({
  requestId: randomUUID(),
  organizationId: "org-a",
  prompt: "Improve the landing page",
  agentLimit: 6,
  files,
});

beforeAll(async () => {
  if (!enabled) return;
  admin = new Client({ connectionString: setupUrl });
  await admin.connect();
  expect((await db.query("select current_user as role")).rows[0].role).toBe("tidy_runtime_fixture");
});
beforeEach(async () => {
  if (!enabled) return;
  process.env.AGENT_RUNNER_SECRET = "disposable-runner-test-secret-with-32-characters";
  await admin.query(`truncate "user","organization" cascade; update "billingDeployment" set "selfHosted"=true;
    insert into "user" ("id","name","email","emailVerified") values
      ('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true),('viewer','Viewer','viewer@example.test',true),('outsider','Outside','out@example.test',true);
    insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ('org-a','A','a',now(),'alice'),('org-b','B','b',now(),'outsider');
    insert into "member" ("id","organizationId","userId","role","createdAt") values
      ('m1','org-a','alice','owner',now()),('m2','org-a','bob','editor',now()),('m3','org-a','viewer','viewer',now()),('m4','org-b','outsider','owner',now()),('m5','org-b','alice','editor',now());
    insert into "designFile" ("id","organizationId","name","createdBy") values ('file-a','org-a','Landing','alice'),('file-b','org-b','Other','outsider');`);
  for (const user of ["alice", "bob", "viewer", "outsider"])
    await admin.query(
      `insert into "agentConnection" ("id","userId","provider","subject","clientId","accountLabel","status") values ($1,$2,'codex','','codex-managed',$2,'connected')`,
      [randomUUID(), user],
    );
});
afterAll(async () => {
  if (enabled) {
    await db.end();
    await admin.end();
  }
});

integration("a six-agent run persists a shared thread without sharing a connection", async () => {
  const created = await startAgentRun("alice", input(), "test-model");
  const snapshot = await getAgentThread("bob", created.threadId);
  expect(snapshot.thread.run?.ownerId).toBe("alice");
  expect(snapshot.thread.run?.agentLimit).toBe(6);
  expect(snapshot.messages[0].content).toBe("Improve the landing page");
  expect(snapshot.workers).toHaveLength(1);
  expect(JSON.stringify(snapshot)).not.toContain("connectionId");
  expect(await listAgentThreads("viewer", "org-a")).toHaveLength(1);
  const events = await getThreadEvents("bob", created.threadId, 0);
  expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  expect(snapshot.thread.sequence).toBe(2);
});
integration(
  "concurrent duplicate submissions create exactly one run, message and lead",
  async () => {
    const request = input();
    const [a, b] = await Promise.all([
      startAgentRun("alice", request, "test-model"),
      startAgentRun("alice", request, "test-model"),
    ]);
    expect(a).toEqual(b);
    expect((await admin.query('select 1 from "agentRun"')).rowCount).toBe(1);
    expect((await getAgentThread("alice", a.threadId)).messages).toHaveLength(1);
    await expect(
      startAgentRun("alice", { ...request, prompt: "Different task" }, "test-model"),
    ).rejects.toThrow("different work");
  },
);
integration(
  "cross-organisation resources, viewers and outsiders cannot start or read unauthorised work",
  async () => {
    const request = input();
    await expect(startAgentRun("viewer", request, "test-model")).rejects.toThrow("access denied");
    await expect(
      startAgentRun(
        "alice",
        { ...request, files: [{ id: "file-b", selectedNodeIds: [] }] },
        "test-model",
      ),
    ).rejects.toThrow("this organisation");
    const created = await startAgentRun("alice", request, "test-model");
    await expect(getAgentThread("outsider", created.threadId)).rejects.toThrow("access denied");
    await expect(getThreadEvents("outsider", created.threadId, 0)).rejects.toThrow("access denied");
    await expect(
      steerAgentRun("bob", created.runId, { requestId: randomUUID(), content: "Use my direction" }),
    ).rejects.toThrow("run owner");
    await expect(stopAgentRun("bob", created.runId)).rejects.toThrow("run owner");
  },
);
integration(
  "two concurrent continuations admit one run; teammates pay for their own later run",
  async () => {
    const first = await startAgentRun("alice", input(), "test-model");
    await stopAgentRun("alice", first.runId);
    const attempts = await Promise.allSettled([
      startAgentRun("bob", { ...input(), threadId: first.threadId }, "test-model"),
      startAgentRun("alice", { ...input(), threadId: first.threadId }, "test-model"),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    const failure = attempts.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(failure.reason.code).toBe("run_active");
    const snapshot = await getAgentThread("alice", first.threadId);
    expect(snapshot.messages).toHaveLength(2);
  },
);
integration(
  "stop is idempotent, fences old executions and interrupts pending instructions",
  async () => {
    const created = await startAgentRun("alice", input(), "test-model");
    const instruction = { requestId: randomUUID(), content: "Use a quieter palette" };
    const id = await steerAgentRun("alice", created.runId, instruction);
    expect(await steerAgentRun("alice", created.runId, instruction)).toBe(id);
    await stopAgentRun("alice", created.runId);
    await stopAgentRun("alice", created.runId);
    const run = (
      await admin.query('select "status","generation" from "agentRun" where "id"=$1', [
        created.runId,
      ])
    ).rows[0];
    expect(run).toEqual({ status: "cancelled", generation: 1 });
    expect((await getAgentThread("alice", created.threadId)).messages.at(-1)?.delivery).toBe(
      "interrupted",
    );
    await expect(
      steerAgentRun("alice", created.runId, { ...instruction, requestId: randomUUID() }),
    ).rejects.toThrow("not accepting");
  },
);
integration("admins can stop teammate work but cannot direct it", async () => {
  const created = await startAgentRun("bob", input(), "test-model");
  await expect(
    steerAgentRun("alice", created.runId, { requestId: randomUUID(), content: "Change it" }),
  ).rejects.toThrow("run owner");
  await stopAgentRun("alice", created.runId);
  expect((await getAgentThread("bob", created.threadId)).thread.run?.status).toBe("cancelled");
});
integration("revocation and archive are checked again on every operation", async () => {
  const created = await startAgentRun("alice", input(), "test-model");
  await admin.query(`delete from "member" where "userId"='bob' and "organizationId"='org-a'`);
  await expect(getAgentThread("bob", created.threadId)).rejects.toThrow("access denied");
  await expect(renameAgentThread("bob", created.threadId, "New name")).rejects.toThrow(
    "access denied",
  );
  await admin.query(`update "designFile" set "archivedAt"=now() where "id"='file-a'`);
  await expect(startAgentRun("alice", input(), "test-model")).rejects.toThrow("active files");
});
integration("disconnect cancels all owned work without cancelling a colleague", async () => {
  const own = await startAgentRun("alice", input(), "test-model");
  const colleague = await startAgentRun("bob", input(), "test-model");
  await disconnectAgentConnection("alice");
  expect((await getAgentThread("bob", own.threadId)).thread.run?.status).toBe("cancelled");
  expect((await getAgentThread("bob", colleague.threadId)).thread.run?.status).toBe("queued");
  await expect(startAgentRun("alice", input(), "test-model")).rejects.toThrow("Connect your Codex");
});
integration("concurrent admission respects the user thread cap", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => startAgentRun("alice", input(), "test-model")),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
  expect((await admin.query('select 1 from "agentRun"')).rowCount).toBe(3);
});

async function claim(user = "alice") {
  const created = await startAgentRun(user, input(), "test-model");
  const run = await claimExecution(randomUUID());
  expect(run?.id).toBe(created.runId);
  return run!;
}
integration(
  "scheduler reserves six agents per run and keeps a third run queued at the owner cap",
  async () => {
    for (let i = 0; i < 3; i++) await startAgentRun("alice", input(), "test-model");
    const a = await claimExecution(randomUUID()),
      b = await claimExecution(randomUUID());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);
    expect(await claimExecution(randomUUID())).toBeNull();
    await stopAgentRun("alice", a!.id);
    expect(await claimExecution(randomUUID())).not.toBeNull();
  },
);
integration(
  "managed spawning counts the lead and rejects recursion and a seventh agent",
  async () => {
    const run = await claim();
    const request = {
      action: "spawn" as const,
      runId: run.id,
      generation: run.generation,
      agentId: run.workers[0].id,
      callId: "one",
      name: "Hero",
      task: "Improve hero",
    };
    const child = (await executeRequest(request)) as { id: string };
    expect(await executeRequest(request)).toEqual(child);
    await expect(
      executeRequest({ ...request, callId: "recursive", agentId: child.id }),
    ).rejects.toThrow("Only the lead");
    for (let i = 0; i < 4; i++) await executeRequest({ ...request, callId: `worker-${i}` });
    await expect(executeRequest({ ...request, callId: "overflow" })).rejects.toThrow("agent count");
  },
);
integration(
  "stopped and expired generations cannot send messages, spawn, or invoke tools",
  async () => {
    const run = await claim();
    await stopAgentRun("alice", run.id);
    await expect(
      executeRequest({
        action: "tool",
        runId: run.id,
        generation: run.generation,
        agentId: run.workers[0].id,
        callId: "late",
        tool: "rename_file",
        arguments: { file_id: "file-a", name: "Late edit" },
      }),
    ).rejects.toThrow("lease");
    expect(
      (await admin.query(`select "name" from "designFile" where "id"='file-a'`)).rows[0].name,
    ).toBe("Landing");
  },
);
integration(
  "embedded tools filter discovery, deny other files, and commit duplicate calls once",
  async () => {
    const run = await claim();
    const request = {
      action: "tool" as const,
      runId: run.id,
      generation: run.generation,
      agentId: run.workers[0].id,
      callId: "rename",
      tool: "rename_file",
      arguments: { file_id: "file-a", name: "Updated" },
    };
    const [a, b] = await Promise.all([executeRequest(request), executeRequest(request)]);
    expect(a).toEqual(b);
    expect(
      (
        await admin.query(
          `select 1 from "agentToolOperation" where "runId"=$1 and "callId"='rename'`,
          [run.id],
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      executeRequest({
        ...request,
        callId: "outside",
        arguments: { file_id: "file-b", name: "No" },
      }),
    ).rejects.toThrow("Attach");
    await expect(
      executeRequest({
        ...request,
        callId: "reuse",
        tool: "create_file",
        arguments: { organization_id: "org-a", name: "No" },
      }),
    ).rejects.toThrow("scope");
    const discovery = (await executeRequest({
      ...request,
      callId: "discover",
      tool: "list_organizations",
      arguments: {},
    })) as { structuredContent: { organizations: { id: string }[] } };
    expect(discovery.structuredContent.organizations.map((row) => row.id)).toEqual(["org-a"]);
  },
);
integration(
  "native MCP writes participate in the receipt transaction and rollback together",
  async () => {
    const run = await claim();
    const request = {
      action: "tool" as const,
      runId: run.id,
      generation: run.generation,
      agentId: run.workers[0].id,
      callId: "frames",
      tool: "add_frames",
      arguments: { file_id: "file-a", frames: [{ x: 10, y: 10, width: 100, height: 100 }] },
    };
    const a = (await executeRequest(request)) as { isError?: boolean };
    expect(a.isError).not.toBe(true);
    expect(await executeRequest(request)).toEqual(a);
    const content = (
      await admin.query(`select "content" from "designDocument" where "fileId"='file-a'`)
    ).rows[0].content;
    expect(content.nodes).toHaveLength(1);
  },
);
integration(
  "membership loss and archived targets revoke an execution before its next write",
  async () => {
    const run = await claim("bob");
    await admin.query(`delete from "member" where "id"='m2'`);
    await expect(
      executeRequest({ action: "heartbeat", runId: run.id, generation: run.generation }),
    ).rejects.toThrow("access denied");
  },
);
integration(
  "expired execution keeps partial output and ends rather than silently replaying writes",
  async () => {
    const run = await claim();
    await executeRequest({
      action: "message",
      runId: run.id,
      generation: run.generation,
      agentId: run.workers[0].id,
      id: randomUUID(),
      content: "Partially completed",
      kind: "assistant",
    });
    await admin.query(
      `update "agentRun" set "leaseExpiresAt"=now()-interval '1 minute' where "id"=$1`,
      [run.id],
    );
    expect(await claimExecution(randomUUID())).toBeNull();
    const snapshot = await getAgentThread("bob", run.threadId);
    expect(snapshot.thread.run?.status).toBe("failed");
    expect(snapshot.thread.run?.reason).toBe("runner_disconnected");
    expect(snapshot.messages.at(-1)?.content).toBe("Partially completed");
  },
);
integration(
  "a receipt failure rolls back the shared MCP mutation and leaves it safe to retry",
  async () => {
    const run = await claim();
    const request = {
      action: "tool" as const,
      runId: run.id,
      generation: run.generation,
      agentId: run.workers[0].id,
      callId: "atomic",
      tool: "rename_file",
      arguments: { file_id: "file-a", name: "Atomic" },
    };
    await admin.query(`create function reject_agent_receipt() returns trigger language plpgsql as $$ begin raise exception 'test receipt failure'; end $$;
    create trigger reject_receipt before insert on "agentToolOperation" for each row execute function reject_agent_receipt()`);
    try {
      await expect(executeRequest(request)).rejects.toThrow("test receipt failure");
      expect(
        (await admin.query(`select "name" from "designFile" where "id"='file-a'`)).rows[0].name,
      ).toBe("Landing");
    } finally {
      await admin.query(
        `drop trigger reject_receipt on "agentToolOperation"; drop function reject_agent_receipt()`,
      );
    }
    await executeRequest(request);
    expect(
      (await admin.query(`select "name" from "designFile" where "id"='file-a'`)).rows[0].name,
    ).toBe("Atomic");
  },
);
integration(
  "explicit organisation scope permits new files and adds only those creations to the run",
  async () => {
    const created = await startAgentRun(
      "alice",
      { ...input(), allowOrganizationChanges: true },
      "test-model",
    );
    const run = (await claimExecution(randomUUID()))!;
    expect(run.id).toBe(created.runId);
    expect(run.allowOrganizationChanges).toBe(true);
    const request = {
      action: "tool" as const,
      runId: run.id,
      generation: run.generation,
      agentId: run.workers[0].id,
      callId: "create",
      tool: "create_file",
      arguments: { organization_id: "org-a", name: "New landing page" },
    };
    const result = (await executeRequest(request)) as {
      structuredContent: { file: { id: string } };
    };
    const id = result.structuredContent.file.id;
    expect(await executeRequest(request)).toEqual(result);
    const read = (await executeRequest({
      ...request,
      callId: "read-created",
      tool: "get_file",
      arguments: { file_id: id },
    })) as { isError?: boolean };
    expect(read.isError).not.toBe(true);
    expect(
      (await getAgentThread("bob", run.threadId)).thread.files.map((file) => file.id),
    ).toContain(id);
    await expect(
      executeRequest({
        ...request,
        callId: "other-org",
        arguments: { organization_id: "org-b", name: "No" },
      }),
    ).rejects.toThrow("another organisation");
  },
);
integration(
  "a file moved out of the organisation is removed from live thread attachments",
  async () => {
    const run = await claim();
    await admin.query(
      `update "designFile" set "organizationId"='org-b',"name"='Private new name' where "id"='file-a'`,
    );
    expect((await getAgentThread("bob", run.threadId)).thread.files).toEqual([]);
    expect(JSON.stringify(await listAgentThreads("bob", "org-a"))).not.toContain(
      "Private new name",
    );
  },
);

integration(
  "credential commits survive tool rollback even when every normal pool connection is occupied",
  async () => {
    let arrived = 0,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        agentTransaction(async (client) => {
          await client.query("select 1");
          if (++arrived === 5) release();
          await barrier;
          await inDatabaseScope(client, async () => {
            await withoutDatabaseScope(() =>
              db.query(`update "agentConnection" set "accountLabel"=$1 where "userId"='alice'`, [
                `Renewed ${index}`,
              ]),
            );
            throw new Error("Tool rolled back");
          });
        }),
      ),
    );
    expect(
      results.every(
        (result) => result.status === "rejected" && result.reason.message === "Tool rolled back",
      ),
    ).toBe(true);
    expect(
      (await admin.query(`select "accountLabel" from "agentConnection" where "userId"='alice'`))
        .rows[0].accountLabel,
    ).toMatch(/^Renewed /);
  },
);
integration(
  "thread pagination keeps rows with identical update times reachable exactly once",
  async () => {
    const ids = Array.from({ length: 55 }, () => randomUUID());
    await admin.query(
      `insert into "agentThread" ("id","organizationId","createdBy","title","updatedAt") select id,'org-a','alice','Earlier thread','2026-10-05T12:00:00.123456Z'::timestamptz from unnest($1::uuid[]) as id`,
      [ids],
    );
    const first = await listAgentThreads("alice", "org-a");
    const second = await listAgentThreads("alice", "org-a", undefined, first.at(-1)!.cursor);
    expect(first).toHaveLength(50);
    expect(second).toHaveLength(5);
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(55);
  },
);
integration(
  "confirmed provider limits suppress queued inference on that owner's connection",
  async () => {
    const run = await claim();
    await startAgentRun("alice", input(), "test-model");
    await executeRequest({
      action: "finish",
      runId: run.id,
      generation: run.generation,
      status: "limited",
      reason: "usage_limit",
    });
    expect(await claimExecution(randomUUID())).toBeNull();
    await stopAgentRun("alice", run.id);
    expect(await claimExecution(randomUUID())).not.toBeNull();
  },
);
integration(
  "a provider authentication failure makes the personal connection require reconnecting",
  async () => {
    const run = await claim();
    await executeRequest({
      action: "finish",
      runId: run.id,
      generation: run.generation,
      status: "failed",
      reason: "connection_required",
    });
    expect(
      (await admin.query(`select "status" from "agentConnection" where "userId"='alice'`)).rows[0]
        .status,
    ).toBe("reconnect");
    await expect(startAgentRun("alice", input(), "test-model")).rejects.toThrow("Connect");
  },
);

integration(
  "agent thread admission serializes the final workspace slot and preserves retries",
  async () => {
    const { AGENT_HISTORY_LIMITS } = await import("./store");
    await admin.query(
      `insert into "agentThread" ("id","organizationId","createdBy","title") select gen_random_uuid(),'org-a','alice','History' from generate_series(1,$1)`,
      [AGENT_HISTORY_LIMITS.threads - 1],
    );
    const requests = [input(), input()];
    const results = await Promise.allSettled(
      requests.map((request) => startAgentRun("alice", request, "test-model")),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === "fulfilled");
    expect(await startAgentRun("alice", requests[winner], "test-model")).toEqual(
      (results[winner] as PromiseFulfilledResult<{ runId: string; threadId: string }>).value,
    );
    expect(
      (
        await admin.query(
          `select count(*)::int as count from "agentThread" where "organizationId"='org-a'`,
        )
      ).rows[0].count,
    ).toBe(AGENT_HISTORY_LIMITS.threads);
    await expect(
      startAgentRun(
        "outsider",
        { ...input(), organizationId: "org-b", files: [{ id: "file-b", selectedNodeIds: [] }] },
        "test-model",
      ),
    ).resolves.toBeDefined();
  },
);

for (const ceiling of [
  "runs",
  "threadRuns",
  "userStartsPerHour",
  "workspaceStartsPerHour",
] as const)
  integration(`agent admission enforces ${ceiling} without creating partial history`, async () => {
    const { AGENT_HISTORY_LIMITS } = await import("./store");
    const request = input();
    const first = await startAgentRun("alice", request, "test-model");
    await admin.query(
      `update "agentRun" set "status"='completed',"createdAt"=now()-interval '2 hours' where "id"=$1`,
      [first.runId],
    );
    const recent = ceiling.endsWith("PerHour");
    const owner = ceiling === "workspaceStartsPerHour" ? "bob" : "alice";
    await admin.query(
      `insert into "agentRun" ("id","threadId","ownerId","connectionId","requestId","requestHash","agentLimit","model","status","createdAt")
    select gen_random_uuid(),r."threadId",$2,r."connectionId",gen_random_uuid(),'seed',1,'test','completed',case when $3 then now() else now()-interval '2 hours' end
    from "agentRun" r cross join generate_series(1,$4) where r."id"=$1`,
      [first.runId, owner, recent, AGENT_HISTORY_LIMITS[ceiling] - (recent ? 0 : 1)],
    );
    const before = (await admin.query('select count(*)::int as count from "agentRun"')).rows[0]
      .count;
    await expect(
      startAgentRun(
        "alice",
        { ...input(), ...(ceiling === "threadRuns" ? { threadId: first.threadId } : {}) },
        "test-model",
      ),
    ).rejects.toThrow(recent ? "Too many agent runs" : "history limit");
    expect((await admin.query('select count(*)::int as count from "agentRun"')).rows[0].count).toBe(
      before,
    );
    expect(
      (await admin.query('select count(*)::int as count from "agentThread"')).rows[0].count,
    ).toBe(1);
    expect(await startAgentRun("alice", request, "test-model")).toEqual(first);
  });

integration(
  "agent event retention preserves run authority and invalidates clients behind its cutoff",
  async () => {
    const { AGENT_HISTORY_LIMITS } = await import("./store");
    const created = await startAgentRun("alice", input(), "test-model");
    const count = AGENT_HISTORY_LIMITS.events + 100;
    await admin.query(
      `insert into "agentEvent" ("threadId","sequence","type","payload") select $1,n+2,'message.updated','{}'::jsonb from generate_series(1,$2) n`,
      [created.threadId, count],
    );
    await admin.query('update "agentThread" set "sequence"=$2 where "id"=$1', [
      created.threadId,
      count + 2,
    ]);
    await renameAgentThread("alice", created.threadId, "Retained conversation");
    expect(
      (
        await admin.query(
          `select count(*)::int as count from "agentEvent" where "threadId"=$1 and "type" not in ('run.created','run.file.created')`,
          [created.threadId],
        )
      ).rows[0].count,
    ).toBe(AGENT_HISTORY_LIMITS.events);
    expect(
      (
        await admin.query(
          `select 1 from "agentEvent" where "threadId"=$1 and "type"='run.created'`,
          [created.threadId],
        )
      ).rowCount,
    ).toBe(1);
    expect((await getAgentThread("alice", created.threadId)).messages[0].content).toBe(
      "Improve the landing page",
    );
    expect((await getThreadEvents("alice", created.threadId, 2))[0].type).toBe(
      "thread.invalidated",
    );
    const claimed = await claimExecution(randomUUID());
    expect(claimed?.id).toBe(created.runId);
    expect(claimed?.files).toEqual(files);
  },
);

integration(
  "concurrent agent messages obey the final count slot and allow streamed replacement at capacity",
  async () => {
    const { AGENT_RUN_LIMITS } = await import("./history-limits");
    const run = await claim();
    await admin.query(
      `insert into "agentMessage" ("id","threadId","runId","agentId","kind","content","sequence")
    select gen_random_uuid(),$1,$2,$3,'assistant','seed',n+100 from generate_series(1,$4) n`,
      [run.threadId, run.id, run.workers[0].id, AGENT_RUN_LIMITS.messages - 2],
    );
    await admin.query('update "agentThread" set "sequence"=$2 where "id"=$1', [
      run.threadId,
      AGENT_RUN_LIMITS.messages + 100,
    ]);
    const request = {
      action: "message" as const,
      runId: run.id,
      generation: run.generation,
      agentId: run.workers[0].id,
      kind: "assistant" as const,
      content: "Final message",
    };
    const ids = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled(ids.map((id) => executeRequest({ ...request, id })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await admin.query('select count(*)::int as count from "agentMessage" where "runId"=$1', [
          run.id,
        ])
      ).rows[0].count,
    ).toBe(AGENT_RUN_LIMITS.messages);
    const id = ids[results.findIndex((result) => result.status === "fulfilled")];
    await executeRequest({ ...request, id, content: "Updated final message" });
    expect(
      (await admin.query('select "content" from "agentMessage" where "id"=$1', [id])).rows[0]
        .content,
    ).toBe("Updated final message");
    await stopAgentRun("alice", run.id);
    expect((await getAgentThread("alice", run.threadId)).thread.run?.status).toBe("cancelled");
  },
);

integration(
  "agent message byte admission counts UTF-8 and preserves existing output on rejection",
  async () => {
    const run = await claim();
    await admin.query(
      `insert into "agentMessage" ("id","threadId","runId","agentId","kind","content","sequence")
    select gen_random_uuid(),$1,$2,$3,'assistant',repeat('x',249998),n+100 from generate_series(1,32) n`,
      [run.threadId, run.id, run.workers[0].id],
    );
    await admin.query('update "agentThread" set "sequence"=200 where "id"=$1', [run.threadId]);
    const request = {
      action: "message" as const,
      runId: run.id,
      generation: run.generation,
      agentId: run.workers[0].id,
      id: randomUUID(),
      kind: "assistant" as const,
      content: "ok",
    };
    await executeRequest(request);
    await expect(executeRequest({ ...request, content: "😀".repeat(20) })).rejects.toThrow(
      "message history limit",
    );
    expect(
      (await admin.query('select "content" from "agentMessage" where "id"=$1', [request.id]))
        .rows[0].content,
    ).toBe("ok");
  },
);

integration(
  "tool operation limits preserve retries and prevent additional product writes",
  async () => {
    const { AGENT_RUN_LIMITS } = await import("./history-limits");
    const run = await claim();
    await admin.query(
      `insert into "agentToolOperation" ("runId","callId","agentId","tool","inputHash","result","status")
    select $1,'seed-'||n,$2,'test','seed','{}'::jsonb,'completed' from generate_series(1,$3) n`,
      [run.id, run.workers[0].id, AGENT_RUN_LIMITS.operations - 1],
    );
    const request = {
      action: "tool" as const,
      runId: run.id,
      generation: run.generation,
      agentId: run.workers[0].id,
      callId: "final",
      tool: "rename_file",
      arguments: { file_id: "file-a", name: "Final name" },
    };
    const result = await executeRequest(request);
    expect(await executeRequest(request)).toEqual(result);
    await expect(
      executeRequest({
        ...request,
        callId: "overflow",
        arguments: { ...request.arguments, name: "Rejected" },
      }),
    ).rejects.toThrow("tool operation limit");
    expect(
      (await admin.query(`select "name" from "designFile" where "id"='file-a'`)).rows[0].name,
    ).toBe("Final name");
  },
);

integration(
  "a tool result byte rejection rolls back its product mutation and receipt",
  async () => {
    const { AGENT_RUN_LIMITS, admitAgentResult } = await import("./history-limits");
    const run = await claim();
    await admin.query(
      `insert into "agentToolOperation" ("runId","callId","agentId","tool","inputHash","result","status")
    select $1,'seed-'||n,$2,'test','seed',to_jsonb(repeat('x',999998)),'completed' from generate_series(1,16) n`,
      [run.id, run.workers[0].id],
    );
    const request = {
      action: "tool" as const,
      runId: run.id,
      generation: run.generation,
      agentId: run.workers[0].id,
      callId: "overflow",
      tool: "rename_file",
      arguments: { file_id: "file-a", name: "Rejected" },
    };
    await expect(executeRequest(request)).rejects.toThrow("tool result exceeds");
    expect(
      (await admin.query(`select "name" from "designFile" where "id"='file-a'`)).rows[0].name,
    ).toBe("Landing");
    expect(
      (
        await admin.query(
          `select 1 from "agentToolOperation" where "runId"=$1 and "callId"='overflow'`,
          [run.id],
        )
      ).rowCount,
    ).toBe(0);
    await admin.query('delete from "agentToolOperation" where "runId"=$1', [run.id]);
    await expect(
      agentTransaction((client) =>
        admitAgentResult(client, run.id, JSON.stringify("x".repeat(AGENT_RUN_LIMITS.resultBytes))),
      ),
    ).rejects.toThrow("tool result exceeds");
    await executeRequest(request);
    expect(
      (await admin.query(`select "name" from "designFile" where "id"='file-a'`)).rows[0].name,
    ).toBe("Rejected");
  },
);

integration(
  "queued product admission retains no file/identity locks and rejects intervening revocation",
  async () => {
    const run = await claim();
    const { Client } = await import("pg");
    const blocker = new Client({ connectionString: setupUrl });
    await blocker.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("begin");
      await blocker.query("set local lock_timeout='500ms'");
      const pid = (await blocker.query("select pg_backend_pid() as pid")).rows[0].pid;
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", ["org-a"]);
      pending = executeRequest({
        action: "tool",
        runId: run.id,
        generation: run.generation,
        agentId: run.workers[0].id,
        callId: "queued-import",
        tool: "create_import",
        arguments: { organization_id: "org-a", file_id: "file-a", name: "Queued" },
      }).then(
        (value) => value,
        (error) => error,
      );
      let blocked = false;
      const observationDeadline = Date.now() + 3000;
      while (Date.now() < observationDeadline && !blocked) {
        // Statistics snapshots are cached within this observer transaction.
        await blocker.query("select pg_stat_clear_snapshot()");
        blocked = (
          await blocker.query(
            `select exists(select 1 from pg_stat_activity
        where query like 'select pg_advisory_xact_lock(hashtextextended%'
        and $1=any(pg_blocking_pids(pid))) as blocked`,
            [pid],
          )
        ).rows[0].blocked;
        if (!blocked) await Bun.sleep(5);
      }
      expect(blocked).toBe(true);
      // These must complete while admission remains blocked, not form a lock cycle.
      await blocker.query(`update "designFile" set "name"='Concurrent edit' where "id"='file-a'`);
      await blocker.query(`update "member" set "role"='viewer' where "id"='m1'`);
      await blocker.query(`update "user" set "emailVerified"=false where "id"='alice'`);
      await blocker.query("commit");
      expect(((await pending) as Error).message).toContain("access denied");
      expect((await admin.query('select 1 from "designImport"')).rowCount).toBe(0);
      expect((await admin.query('select 1 from "agentToolOperation"')).rowCount).toBe(0);
      expect(
        (await admin.query('select "name" from "designFile" where "id"=\'file-a\'')).rows[0].name,
      ).toBe("Concurrent edit");
    } finally {
      await blocker.query("rollback").catch(() => {});
      await pending?.catch(() => {});
      await blocker.end();
    }
  },
);

integration(
  "queued work loses verification before the scheduler can disclose its conversation",
  async () => {
    const created = await startAgentRun("alice", input(), "test-model");
    await admin.query(`update "user" set "emailVerified"=false where "id"='alice'`);
    expect(await claimExecution(randomUUID())).toBeNull();
    expect(
      (await admin.query(`select "status","reason" from "agentRun" where "id"=$1`, [created.runId]))
        .rows[0],
    ).toEqual({ status: "failed", reason: "connection_or_access_lost" });
  },
);
integration("a run cannot claim another person's connected account", async () => {
  const created = await startAgentRun("alice", input(), "test-model");
  await admin.query(
    `update "agentRun" set "connectionId"=(select "id" from "agentConnection" where "userId"='bob') where "id"=$1`,
    [created.runId],
  );
  expect(await claimExecution(randomUUID())).toBeNull();
  expect(
    (await admin.query(`select "status" from "agentRun" where "id"=$1`, [created.runId])).rows[0]
      .status,
  ).toBe("failed");
});
integration("running work loses verification before every subsequent runner action", async () => {
  const run = await claim();
  await admin.query(`update "user" set "emailVerified"=false where "id"='alice'`);
  for (const request of [
    { action: "heartbeat" as const },
    { action: "instructions" as const, delivered: [] },
    {
      action: "message" as const,
      agentId: run.workers[0].id,
      id: randomUUID(),
      content: "Forbidden",
      kind: "assistant" as const,
    },
    {
      action: "tool" as const,
      agentId: run.workers[0].id,
      callId: "forbidden",
      tool: "rename_file",
      arguments: { file_id: "file-a", name: "Forbidden" },
    },
  ])
    await expect(
      executeRequest({ ...request, runId: run.id, generation: run.generation }),
    ).rejects.toMatchObject({ status: 403 });
  expect(
    (await admin.query(`select "name" from "designFile" where "id"='file-a'`)).rows[0].name,
  ).toBe("Landing");
  expect(
    (await admin.query(`select 1 from "agentMessage" where "content"='Forbidden'`)).rows,
  ).toEqual([]);
});
integration("thread reads waiting for a parent lock recheck current verification", async () => {
  const run = await startAgentRun("alice", input(), "test-model");
  const blocker = new Client({ connectionString: setupUrl });
  await blocker.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await blocker.query("begin");
    await blocker.query(`select 1 from "agentThread" where "id"=$1 for update`, [run.threadId]);
    pending = getAgentThread("bob", run.threadId).then(
      () => null,
      (e) => e,
    );
    const holder = (await blocker.query("select pg_backend_pid() as pid")).rows[0].pid;
    let blocked = false;
    for (let n = 0; n < 100; n++) {
      blocked = (
        await admin.query(
          `select exists(select 1 from pg_stat_activity where usename='tidy_runtime_fixture' and $1=any(pg_blocking_pids(pid))) as blocked`,
          [holder],
        )
      ).rows[0].blocked;
      if (blocked) break;
      await Bun.sleep(5);
    }
    expect(blocked).toBe(true);
    await blocker.query(`update "user" set "emailVerified"=false where "id"='bob'`);
    await blocker.query("commit");
    expect(await pending).toMatchObject({ status: 403 });
    await expect(getThreadEvents("bob", run.threadId, 0)).rejects.toMatchObject({ status: 403 });
  } finally {
    await blocker.query("rollback").catch(() => {});
    await pending;
    await blocker.end();
  }
});
integration(
  "admitted shared tools complete before disconnect and all later tools are fenced",
  async () => {
    const run = await claim(),
      request = {
        action: "tool" as const,
        runId: run.id,
        generation: run.generation,
        agentId: run.workers[0].id,
        callId: "admitted",
        tool: "rename_file",
        arguments: { file_id: "file-a", name: "Admitted" },
      };
    const blocker = new Client({ connectionString: setupUrl });
    await blocker.connect();
    let tool: Promise<unknown> | undefined, disconnect: Promise<unknown> | undefined;
    try {
      await blocker.query("begin");
      await blocker.query(`select 1 from "designDocument" where "fileId"='file-a' for update`);
      // rename_file does not touch the document; hold its file row instead, before
      // the tool takes its write lock but after it locks the run and connection.
      await blocker.query(`select 1 from "designFile" where "id"='file-a' for update`);
      tool = executeRequest(request);
      const pid = (await blocker.query("select pg_backend_pid() as pid")).rows[0].pid;
      let blocked = false;
      for (let n = 0; n < 100; n++) {
        blocked = (
          await admin.query(
            `select exists(select 1 from pg_stat_activity where usename='tidy_runtime_fixture' and $1=any(pg_blocking_pids(pid))) as blocked`,
            [pid],
          )
        ).rows[0].blocked;
        if (blocked) break;
        await Bun.sleep(5);
      }
      expect(blocked).toBe(true);
      disconnect = disconnectAgentConnection("alice");
      await blocker.query("commit");
      await tool;
      await disconnect;
      expect(
        (await admin.query(`select "name" from "designFile" where "id"='file-a'`)).rows[0].name,
      ).toBe("Admitted");
      await expect(
        executeRequest({
          ...request,
          callId: "later",
          arguments: { file_id: "file-a", name: "Forbidden" },
        }),
      ).rejects.toMatchObject({ code: "lease_lost" });
    } finally {
      await blocker.query("rollback").catch(() => {});
      await tool?.catch(() => {});
      await disconnect?.catch(() => {});
      await blocker.end();
    }
  },
);

integration(
  "generic MCP failures hide storage/database internals but retain deliberate field errors",
  async () => {
    const run = await claim(),
      req = {
        action: "tool" as const,
        runId: run.id,
        generation: run.generation,
        agentId: run.workers[0].id,
        tool: "create_import",
        arguments: { organization_id: "org-a", file_id: "file-a", name: "Pending" },
      };
    await admin.query(
      `create function reject_private_import() returns trigger language plpgsql as $$ begin raise exception 'private internal-host and access-token'; end $$; create trigger reject_import before insert on "designImport" for each row execute function reject_private_import()`,
    );
    try {
      const result = await executeRequest({ ...req, callId: "private" });
      expect(JSON.stringify(result)).not.toContain("internal-host");
      expect(JSON.stringify(result)).not.toContain("access-token");
      expect((result as { isError: boolean }).isError).toBe(true);
    } finally {
      await admin.query(
        `drop trigger reject_import on "designImport"; drop function reject_private_import()`,
      );
    }
    const invalid = await executeRequest({
      ...req,
      callId: "validation",
      tool: "put_asset",
      arguments: { organization_id: "org-a", mime_type: "image/png", base64: "AAAA" },
    });
    expect(JSON.stringify(invalid)).toContain("Invalid PNG");
  },
);
