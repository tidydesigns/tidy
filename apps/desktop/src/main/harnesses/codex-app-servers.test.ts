import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { HarnessSessions } from "./harness-sessions";
import { CodexAppServers } from "./codex-app-servers";
import type { HarnessUpdate } from "./harnesses";

let directory: string;
let executable: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "tidy-codex-server-tests-"));
  await symlink(
    join(import.meta.dir, "../../../node_modules"),
    join(directory, "node_modules"),
    "junction",
  );
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures/codex-server.ts")],
    outdir: directory,
    target: "node",
    packages: "external",
  });
  if (!build.success) throw new AggregateError(build.logs);
  executable = build.outputs[0].path;
  await chmod(executable, 0o700);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
const eventSchema = z.object({
  pid: z.number(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  id: z.union([z.string(), z.number()]).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
async function events(cwd: string) {
  return (await readFile(join(cwd, "codex-events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => eventSchema.parse(JSON.parse(line)));
}
async function fixture(options = { idleLimit: 2, idleMs: 60_000 }) {
  const cwd = await mkdtemp(join(directory, "project-"));
  const sessions = new HarnessSessions(options);
  const context = { projectId: "project", harness: "codex" as const, executable, cwd };
  function start(id: string, prompt: string) {
    const updates: HarnessUpdate[] = [];
    const started = Promise.withResolvers<void>();
    const approval = Promise.withResolvers<string>();
    const run = sessions.start(id, {
      ...context,
      prompt,
      onUpdate(update) {
        updates.push(update);
        if (update.type === "started") started.resolve();
        if (update.type === "approval") approval.resolve(update.request.id);
      },
    });
    return { run, updates, started: started.promise, approval: approval.promise };
  }
  return { sessions, cwd, context, start };
}
function reply(updates: HarnessUpdate[]) {
  return updates
    .filter((event) => event.type === "message")
    .map((event) => event.text)
    .join("");
}

test("concurrent threads share one handshake and process while keeping streams and interruption isolated", async () => {
  const f = await fixture();
  try {
    const alpha = f.start("alpha", "stream");
    const beta = f.start("beta", "hold");
    await Promise.all([alpha.started, beta.started]);
    beta.run.stop();
    await Promise.all([alpha.run.done, beta.run.done]);
    expect(reply(alpha.updates)).toBe(Array.from({ length: 30 }, (_, i) => `${i},`).join(""));
    expect(reply(beta.updates)).toBe("");
    const recorded = await events(f.cwd);
    expect(new Set(recorded.map((event) => event.pid)).size).toBe(1);
    expect(recorded.filter((event) => event.method === "initialize")).toHaveLength(1);
    expect(recorded.filter((event) => event.method === "initialized")).toHaveLength(1);
    const threads = recorded
      .filter((event) => event.method === "turn/start")
      .map((event) => event.params?.threadId);
    expect(new Set(threads).size).toBe(2);
    expect(recorded.find((event) => event.method === "turn/interrupt")?.params?.threadId).toBe(
      threads[1],
    );
  } finally {
    await f.sessions.clear();
  }
});

test("approval replies cannot cross threads and a pending approval does not block its sibling", async () => {
  const f = await fixture();
  try {
    const alpha = f.start("alpha", "approve");
    const beta = f.start("beta", "approve");
    const [a, b] = await Promise.all([alpha.approval, beta.approval]);
    expect(alpha.run.respondToApproval?.(b, "allow")).toBe(false);
    expect(beta.run.respondToApproval?.(a, "allow")).toBe(false);
    expect(alpha.run.respondToApproval?.(a, "allow")).toBe(true);
    await alpha.run.done;
    expect(reply(beta.updates)).toBe("");
    beta.run.stop();
    await beta.run.done;
    expect(beta.run.respondToApproval?.(b, "allow")).toBe(false);
    expect(reply(alpha.updates)).toBe("approved");
  } finally {
    await f.sessions.clear();
  }
});

test("resolved and unknown-thread server requests are routed or rejected once", async () => {
  const f = await fixture();
  try {
    const alpha = f.start("alpha", "approve resolved");
    const beta = f.start("beta", "foreign");
    await Promise.all([alpha.run.done, beta.run.done]);
    expect(alpha.updates.filter((event) => event.type === "approval-resolved")).toHaveLength(1);
    expect(beta.updates.some((event) => event.type === "approval")).toBe(false);
    // Drain a subsequent RPC to ensure the fixture has recorded the rejection.
    await f.start("third", "next").run.done;
    const rejected = (await events(f.cwd)).filter(
      (event) => event.id === "foreign-request" && event.error,
    );
    expect(rejected).toHaveLength(1);
    expect(reply(beta.updates)).toBe("owned");
  } finally {
    await f.sessions.clear();
  }
});

test("different models and permission policies share a server without inheriting sibling settings", async () => {
  const f = await fixture();
  try {
    const output: string[] = [];
    await Promise.all(
      ["alpha", "beta"].map(
        (model, index) =>
          f.sessions.start(model, {
            ...f.context,
            settings: {
              model,
              effort: index ? "high" : "low",
              permissionMode: index ? "auto" : "read-only",
            },
            prompt: "reply",
            onUpdate(event) {
              if (event.type === "message") output.push(event.text);
            },
          }).done,
      ),
    );
    expect(output.sort()).toEqual(["alpha", "beta"]);
    const recorded = await events(f.cwd);
    expect(new Set(recorded.map((event) => event.pid)).size).toBe(1);
    expect(
      recorded.filter((event) => event.method === "thread/start").map((event) => event.params),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "alpha",
          sandbox: "read-only",
          approvalPolicy: "on-request",
          config: { model_reasoning_effort: "low" },
        }),
        expect.objectContaining({
          model: "beta",
          sandbox: "danger-full-access",
          approvalPolicy: "never",
          config: { model_reasoning_effort: "high" },
        }),
      ]),
    );
  } finally {
    await f.sessions.clear();
  }
});

test("thread initialization failure and duplicate resume cannot mutate or close a running sibling", async () => {
  const f = await fixture();
  try {
    const alpha = f.start("alpha", "hold");
    await alpha.started;
    const session = alpha.updates.find((event) => event.type === "session");
    if (session?.type !== "session") throw new Error("Missing session");
    await expect(
      f.sessions.start("failed", {
        ...f.context,
        settings: { model: "reject-thread" },
        prompt: "reply",
        onUpdate() {},
      }).done,
    ).rejects.toThrow("Thread initialization failed");
    await expect(
      f.sessions.start("duplicate", {
        ...f.context,
        sessionId: session.id,
        settings: { model: "wrong" },
        prompt: "reply",
        onUpdate() {},
      }).done,
    ).rejects.toThrow("already open");
    expect((await events(f.cwd)).filter((event) => event.method === "thread/resume")).toHaveLength(
      0,
    );
    expect(await alpha.run.steer?.({ prompt: "finish", images: [] })).toBe(true);
    await alpha.run.done;
    expect(reply(alpha.updates)).toBe("steered");
  } finally {
    await f.sessions.clear();
  }
});

test("a shared process crash fails every affected turn and the next send creates one fresh server", async () => {
  const f = await fixture();
  try {
    const alpha = f.start("alpha", "hold");
    await alpha.started;
    const beta = f.start("beta", "crash");
    const results = await Promise.allSettled([alpha.run.done, beta.run.done]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    const fresh = f.start("fresh", "reply");
    await fresh.run.done;
    expect(reply(fresh.updates)).toBe("fixture-model");
    expect(new Set((await events(f.cwd)).map((event) => event.pid)).size).toBe(2);
    expect((await events(f.cwd)).filter((event) => event.method === "turn/start")).toHaveLength(3);
  } finally {
    await f.sessions.clear();
  }
});

test("idle thread eviction unsubscribes it while a sibling continues streaming", async () => {
  const f = await fixture({ idleLimit: 1, idleMs: 40 });
  try {
    await f.start("idle", "reply").run.done;
    const busy = f.start("busy", "stream");
    await busy.run.done;
    expect(reply(busy.updates)).toBe(Array.from({ length: 30 }, (_, i) => `${i},`).join(""));
    expect(new Set((await events(f.cwd)).map((event) => event.pid)).size).toBe(1);
    expect((await events(f.cwd)).some((event) => event.method === "thread/unsubscribe")).toBe(true);
  } finally {
    await f.sessions.clear();
  }
});

test("the channel rejects forged approval replies even when native request IDs are known", async () => {
  const cwd = await mkdtemp(join(directory, "channels-"));
  const servers = new CodexAppServers();
  const context = { projectId: "project", harness: "codex" as const, executable, cwd };
  const a = servers.acquire(context),
    b = servers.acquire(context);
  const approval = Promise.withResolvers<unknown>();
  a.onMessage = (message) => {
    if (message.id !== undefined) approval.resolve(message.id);
  };
  try {
    await Promise.all([a.request("initialize", {}), b.request("initialize", {})]);
    const result = z
      .object({ thread: z.object({ id: z.string() }) })
      .parse(await a.request("thread/start", {}));
    await a.request("turn/start", { threadId: result.thread.id, input: [{ text: "approve" }] });
    const id = await approval.promise;
    expect(b.respond(id, { decision: "accept" })).toBe(false);
    expect(b.reject(id, "forged")).toBe(false);
    expect(a.respond(id, { decision: "accept" })).toBe(true);
  } finally {
    await servers.clear(() => true, false);
  }
});

test("project and execution-directory boundaries isolate processes and scoped revocation", async () => {
  const f = await fixture();
  const otherDirectory = await mkdtemp(join(directory, "other-directory-"));
  const firstStarted = Promise.withResolvers<void>();
  let secondSession: string | undefined;
  try {
    const first = f.sessions.start("first", {
      ...f.context,
      prompt: "hold",
      onUpdate(event) {
        if (event.type === "started") firstStarted.resolve();
      },
    });
    const settled = first.done.then(
      () => "completed",
      () => "failed",
    );
    await firstStarted.promise;
    await f.sessions.start("second", {
      ...f.context,
      projectId: "other-project",
      prompt: "reply",
      onUpdate(event) {
        if (event.type === "session") secondSession = event.id;
      },
    }).done;
    await f.sessions.start("third", {
      ...f.context,
      cwd: otherDirectory,
      prompt: "reply",
      onUpdate() {},
    }).done;
    const before = await events(f.cwd);
    expect(new Set(before.map((event) => event.pid)).size).toBe(2);
    expect(new Set((await events(otherDirectory)).map((event) => event.pid)).size).toBe(1);
    await f.sessions.clear({ projectIds: new Set(["project"]) });
    expect(await settled).toBe("failed");
    await f.sessions.start("second", {
      ...f.context,
      projectId: "other-project",
      sessionId: secondSession,
      prompt: "reply",
      onUpdate() {},
    }).done;
    const after = await events(f.cwd);
    expect(new Set(after.map((event) => event.pid)).size).toBe(2);
    expect(after.filter((event) => event.method === "initialize")).toHaveLength(2);
  } finally {
    await f.sessions.clear();
  }
});

test("an unresponsive interrupt tears down the affected server and reports sibling failure without replay", async () => {
  const f = await fixture();
  try {
    const stuck = f.start("stuck", "stubborn");
    const sibling = f.start("sibling", "hold");
    const settled = Promise.allSettled([stuck.run.done, sibling.run.done]);
    await Promise.all([stuck.started, sibling.started]);
    stuck.run.stop();
    expect((await settled).map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    await f.start("fresh", "reply").run.done;
    const recorded = await events(f.cwd);
    expect(new Set(recorded.map((event) => event.pid)).size).toBe(2);
    expect(recorded.filter((event) => event.method === "turn/start")).toHaveLength(3);
  } finally {
    await f.sessions.clear();
  }
});

test("native requests cannot address a different channel's thread", async () => {
  const cwd = await mkdtemp(join(directory, "request-ownership-"));
  const servers = new CodexAppServers();
  const context = { projectId: "project", harness: "codex" as const, executable, cwd };
  const a = servers.acquire(context),
    b = servers.acquire(context);
  try {
    await Promise.all([a.request("initialize", {}), b.request("initialize", {})]);
    const result = z
      .object({ thread: z.object({ id: z.string() }) })
      .parse(await a.request("thread/start", {}));
    await expect(
      b.request("turn/interrupt", { threadId: result.thread.id, turnId: "foreign" }),
    ).rejects.toThrow("another Codex thread");
    await expect(
      b.request("thread/resume", { threadId: result.thread.id, model: "wrong" }),
    ).rejects.toThrow("already open");
    expect(
      (await events(cwd)).some(
        (event) => event.method === "turn/interrupt" || event.method === "thread/resume",
      ),
    ).toBe(false);
  } finally {
    await servers.clear(() => true, false);
  }
});

test("shutdown drains server processes and a cancelled thread preparation cannot leak a subscription", async () => {
  const cwd = await mkdtemp(join(directory, "pending-prepare-"));
  const servers = new CodexAppServers();
  const context = { projectId: "project", harness: "codex" as const, executable, cwd };
  const channel = servers.acquire(context);
  const sibling = servers.acquire(context);
  try {
    await Promise.all([channel.request("initialize", {}), sibling.request("initialize", {})]);
    const pending = channel.request("thread/start", {});
    channel.close();
    await expect(pending).rejects.toThrow("connection closed");
    await channel.done;
    const recorded = await events(cwd);
    expect(recorded.filter((event) => event.method === "thread/unsubscribe")).toHaveLength(1);
    await servers.clear(() => true, false);
    for (const { pid } of recorded) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await servers.clear(() => true, false);
  }
});

test("handshake failure is evicted and the next attempt can initialize a fresh server", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cwd, "fail-initialize"), "");
    await expect(f.start("first", "reply").run.done).rejects.toThrow();
    await rm(join(f.cwd, "fail-initialize"));
    const fresh = f.start("fresh", "reply");
    await fresh.run.done;
    expect(reply(fresh.updates)).toBe("fixture-model");
    expect(new Set((await events(f.cwd)).map((event) => event.pid)).size).toBe(2);
  } finally {
    await f.sessions.clear();
  }
});

test("a busy stream delivers all chunks while sibling turns continue completing", async () => {
  const f = await fixture();
  try {
    const flood = f.start("flood", "stream flood");
    await flood.started;
    for (let i = 0; i < 8; i++) {
      const sibling = f.start(`sibling-${i}`, "reply");
      await sibling.run.done;
      expect(reply(sibling.updates)).toBe("fixture-model");
    }
    await flood.run.done;
    expect(reply(flood.updates)).toBe(Array.from({ length: 2000 }, (_, i) => `${i},`).join(""));
    expect(new Set((await events(f.cwd)).map((event) => event.pid)).size).toBe(1);
  } finally {
    await f.sessions.clear();
  }
});

test("a timed-out submission cannot leave invisible native work running on the shared server", async () => {
  const f = await fixture();
  try {
    const sibling = f.start("sibling", "hold");
    const siblingResult = sibling.run.done.then(
      () => "completed",
      () => "failed",
    );
    await sibling.started;
    const unknown = f.start("unknown", "hang-start");
    await expect(unknown.run.done).rejects.toThrow("timed out");
    expect(await siblingResult).toBe("failed");
    expect(unknown.run.deliveryState).toBe("unknown");
    await f.start("fresh", "reply").run.done;
    const recorded = await events(f.cwd);
    expect(new Set(recorded.map((event) => event.pid)).size).toBe(2);
    expect(recorded.filter((event) => event.method === "turn/start")).toHaveLength(3);
  } finally {
    await f.sessions.clear();
  }
}, 20_000);

test("many simultaneous approval turns share a server and settle independently under cancellation", async () => {
  const f = await fixture();
  try {
    const turns = Array.from({ length: 32 }, (_, index) => f.start(`parallel-${index}`, "approve"));
    const requests = await Promise.all(turns.map((turn) => turn.approval));
    expect(new Set(requests).size).toBe(32);
    for (let index = turns.length - 1; index >= 0; index--) {
      if (index % 2) turns[index].run.stop();
      else expect(turns[index].run.respondToApproval?.(requests[index], "allow")).toBe(true);
    }
    await Promise.all(turns.map((turn) => turn.run.done));
    for (let index = 0; index < turns.length; index++)
      expect(reply(turns[index].updates)).toBe(index % 2 ? "" : "approved");
    const recorded = await events(f.cwd);
    expect(new Set(recorded.map((event) => event.pid)).size).toBe(1);
    expect(recorded.filter((event) => event.method === "initialize")).toHaveLength(1);
    expect(recorded.filter((event) => event.method === "turn/start")).toHaveLength(32);
    expect(recorded.filter((event) => event.method === "turn/interrupt")).toHaveLength(16);
  } finally {
    await f.sessions.clear();
  }
});

test("thread-scoped Stop interrupts only its own turn and reuses the surviving server", async () => {
  const f = await fixture();
  try {
    const alpha = f.start("alpha", "approve");
    const beta = f.start("beta", "approve");
    const [, approval] = await Promise.all([alpha.approval, beta.approval]);
    await f.sessions.clear({ threadId: "alpha" });
    await alpha.run.done;
    expect(beta.run.respondToApproval?.(approval, "allow")).toBe(true);
    await beta.run.done;
    await f.start("alpha", "next").run.done;
    expect(reply(beta.updates)).toBe("approved");
    expect(new Set((await events(f.cwd)).map((event) => event.pid)).size).toBe(1);
  } finally {
    await f.sessions.clear();
  }
});

test("shared threads retain distinct tool credentials, command environments and process ownership", async () => {
  const f = await fixture({ idleLimit: 4, idleMs: 60_000 });
  const spawned: number[] = [];
  const exited: string[] = [];
  const closed: string[] = [];
  try {
    for (const id of ["alpha", "beta"]) {
      await f.sessions.prepare({
        kind: "thread",
        id,
        context: {
          ...f.context,
          agentTools: {
            identity: id,
            open: async () => ({
              url: "http://127.0.0.1:1/mcp",
              token: `fixture-${id}`,
              close: () => {
                closed.push(id);
              },
            }),
          },
          processRegistration: async () => ({
            environment: { TIDY_SCOPE_FIXTURE: id },
            onSpawn: (pid) => {
              spawned.push(pid);
            },
            onExit: () => {
              exited.push(id);
            },
            bind: async () => {},
          }),
        },
      });
    }
    const recorded = await events(f.cwd);
    const configs = recorded
      .filter((event) => event.method === "thread/start")
      .map((event) => event.params?.config);
    expect(configs).toEqual(
      ["alpha", "beta"].map((id) => ({
        "shell_environment_policy.set": { TIDY_SCOPE_FIXTURE: id },
        "mcp_servers.tidy": {
          url: "http://127.0.0.1:1/mcp",
          http_headers: { Authorization: `Bearer fixture-${id}` },
          default_tools_approval_mode: "approve",
        },
      })),
    );
    expect(spawned).toHaveLength(2);
    expect(new Set(spawned).size).toBe(1);
    await f.sessions.clear({ threadId: "alpha" });
    expect(exited).toEqual(["alpha"]);
    expect(closed).toContain("alpha");
    expect(closed).not.toContain("beta");
    expect(() => process.kill(spawned[1], 0)).not.toThrow();
  } finally {
    await f.sessions.clear();
  }
  expect(exited).toEqual(["alpha", "beta"]);
  expect(closed).toContain("beta");
});
