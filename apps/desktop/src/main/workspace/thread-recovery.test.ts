import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";
import { HarnessFailureError } from "../harnesses/provider-failure";
import type { startHarness } from "../harnesses/harnesses";
import type { HarnessSessions } from "../harnesses/harness-sessions";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 4000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Recovery did not settle.");
    await Bun.sleep(5);
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tidy-recovery-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "private");
  const runs: {
    input: Parameters<typeof startHarness>[0];
    finish(): void;
    fail(error: Error): void;
    stopped: boolean;
  }[] = [];
  async function boot() {
    const store = new ProjectStore(directory);
    await store.initialize();
    await store.recover();
    const service = new WorkspaceService(
      store,
      (input) => {
        const done = Promise.withResolvers<void>();
        const run = { input, finish: () => done.resolve(), fail: done.reject, stopped: false };
        runs.push(run);
        input.onUpdate({ type: "session", id: input.sessionId ?? randomUUID() });
        return {
          done: done.promise,
          deliveryState: "accepted",
          stop() {
            run.stopped = true;
            done.resolve();
          },
        };
      },
      async () => "/fixture/agent",
      async () => {},
    );
    cleanup.push(() => service.close());
    return { service, store };
  }
  const initial = await boot();
  await mkdir(join(root, "project"));
  const { project } = await initial.store.open(join(root, "project"));
  const start = () =>
    initial.service.startThread({
      projectId: project.id,
      harness: "codex",
      prompt: "Finish the original request",
      designIds: [],
    });
  return { ...initial, directory, root, boot, project, start, runs };
}

test("unknown provider failures stop after three automatic continuations and retain the request", async () => {
  const f = await fixture();
  spyOn(f.service as unknown as { retryDelay(): number }, "retryDelay").mockReturnValue(5);
  const thread = await f.start();
  for (let index = 0; index < 4; index++) {
    f.runs[index].fail(new HarnessFailureError("Unclassified permanent failure", "unknown"));
    if (index < 3) await until(() => f.runs.length === index + 2);
  }
  await until(
    async () => (await f.service.readThread(f.project.id, thread.id)).status === "failed",
  );
  expect(f.runs).toHaveLength(4);
  const saved = await f.service.readThread(f.project.id, thread.id);
  expect(saved.messages.filter((message) => message.role === "user")).toHaveLength(1);
  expect(saved.recovery).toBeUndefined();
  expect(await f.store.updateResumes.list()).toEqual([]);
});

test("a short request-drain budget does not truncate durable provider flushes", async () => {
  const f = await fixture();
  await f.start();
  const flush = f.store.flush.bind(f.store);
  const slowDisk = spyOn(f.store, "flush").mockImplementation(async () => {
    await Bun.sleep(60);
    await flush();
  });
  try {
    await f.service.close(5);
    expect(f.runs[0].stopped).toBe(true);
    expect(await f.store.updateResumes.list()).toHaveLength(1);
  } finally {
    slowDisk.mockRestore();
  }
});

test("an unresponsive provider still has a separate bounded shutdown and keeps recovery intent", async () => {
  const f = await fixture();
  const thread = await f.start();
  const jobs = Reflect.get(f.service, "jobs") as Map<string, { process: { stop(): void } }>;
  jobs.get(thread.id)!.process.stop = () => {};
  try {
    await expect(f.service.close(5, 20)).rejects.toThrow("could not finish pausing");
    expect(await f.store.updateResumes.list()).toHaveLength(1);
  } finally {
    f.runs[0].finish();
    await f.service.close();
  }
});

test("a rejected replacement message preserves the original provider retry timer", async () => {
  const f = await fixture();
  spyOn(f.service as unknown as { retryDelay(): number }, "retryDelay").mockReturnValue(10_000);
  const thread = await f.start();
  f.runs[0].fail(new HarnessFailureError("Capacity unavailable", "unavailable"));
  await until(async () => Boolean((await f.store.updateResumes.list())[0]?.retryAt));
  const retry = (await f.service.readThread(f.project.id, thread.id)).recovery;
  const changes = Reflect.get(f.service, "repositoryChanges") as Map<string, Promise<unknown>>;
  changes.set("switching", Promise.resolve());
  try {
    await f.service.sendMessage({
      projectId: f.project.id,
      threadId: thread.id,
      text: "Replace the request",
      delivery: "steer",
    });
    expect((await f.service.readThread(f.project.id, thread.id)).recovery).toEqual(retry);
    expect((Reflect.get(f.service, "recoveryTimers") as Map<string, unknown>).has(thread.id)).toBe(
      true,
    );
  } finally {
    changes.delete("switching");
  }
});

for (const tampered of [false, true])
  test(`late background work checkpoints only a trusted completed turn (tampered: ${tampered})`, async () => {
    const f = await fixture();
    const thread = await f.start();
    f.runs[0].finish();
    await until(() =>
      (Reflect.get(f.service, "idleRunCheckpoints") as Map<string, unknown>).has(thread.id),
    );
    expect(await f.store.updateResumes.list()).toEqual([]);
    if (tampered) {
      const changed = await f.store.readThread(f.project.id, thread.id);
      changed.messages[0].text = "An imported replacement request";
      await f.store.writeThread(changed);
    }
    const sessions = Reflect.get(f.service, "sessions") as HarnessSessions;
    Object.defineProperty(sessions, "backgroundContexts", {
      configurable: true,
      get: () => [{ projectId: f.project.id, threadId: thread.id, cwd: f.project.path }],
    });
    try {
      sessions.onBackgroundWorkChanged?.(thread.id, f.project.id, true);
      // Drain the same per-thread serializer after the protocol callback.
      await Reflect.get(f.service, "serialize").call(f.service, thread.id, async () => {});
      const entries = await f.store.updateResumes.list();
      expect(entries).toHaveLength(tampered ? 0 : 1);
      if (!tampered)
        expect(entries[0]).toMatchObject({
          projectId: f.project.id,
          threadId: thread.id,
          background: true,
        });
    } finally {
      Reflect.deleteProperty(sessions, "backgroundContexts");
    }
  });

for (const kind of [
  "unavailable",
  "rate-limit",
  "connection",
  "timeout",
  "session",
  "unknown",
] as const) {
  test(`${kind} retries the existing turn without another user message`, async () => {
    const f = await fixture();
    spyOn(f.service as unknown as { retryDelay(): number }, "retryDelay").mockReturnValue(20);
    const thread = await f.start();
    f.runs[0].input.onUpdate({ type: "message", id: "partial", text: "Work already completed" });
    const queued = await f.service.sendMessage({
      projectId: f.project.id,
      threadId: thread.id,
      text: "Then verify",
      delivery: "queue",
    });
    f.runs[0].fail(new HarnessFailureError("Temporarily unavailable", kind));
    await until(() => f.runs.length === 2);
    const resumed = await f.service.readThread(f.project.id, thread.id);
    expect(resumed.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(resumed.messages.some((message) => message.text === "Work already completed")).toBe(
      true,
    );
    expect(resumed.queuedMessages).toEqual(queued.queuedMessages);
    expect(f.runs[1].input.prompt).toContain("Do not repeat completed actions");
    expect(f.runs[1].input.sessionId).toBe(
      kind === "session"
        ? undefined
        : (await f.store.readThread(f.project.id, thread.id)).sessionId,
    );
    expect(resumed.recovery?.attempt).toBe(1);
  });
}

test("provider retry waits survive quit and relaunch, and Stop cancels the durable intent", async () => {
  const f = await fixture();
  spyOn(f.service as unknown as { retryDelay(): number }, "retryDelay").mockReturnValue(200);
  const thread = await f.start();
  f.runs[0].fail(new HarnessFailureError("Provider out of capacity", "unavailable"));
  await until(async () =>
    Boolean((await f.store.readThread(f.project.id, thread.id)).recovery?.retryAt),
  );
  await f.service.close();
  const next = await f.boot();
  await next.service.resumeUpdatedThreads();
  expect(f.runs).toHaveLength(1);
  await next.service.stopThread(f.project.id, thread.id);
  await Bun.sleep(250);
  expect(f.runs).toHaveLength(1);
  expect((await next.store.readThread(f.project.id, thread.id)).status).toBe("stopped");
  expect(await next.store.updateResumes.list()).toEqual([]);
});

test("ordinary quit and repeated restarts preserve work and require fresh permission", async () => {
  const f = await fixture();
  const thread = await f.start();
  const approvalId = randomUUID();
  f.runs[0].input.onUpdate({
    type: "approval",
    request: { id: approvalId, title: "Allow action?", choices: ["allow", "deny"] },
  });
  await f.service.close();
  for (let count = 2; count <= 3; count++) {
    const next = await f.boot();
    await Promise.all([next.service.resumeUpdatedThreads(), next.service.resumeUpdatedThreads()]);
    expect(f.runs).toHaveLength(count);
    expect(
      (await next.service.readThread(f.project.id, thread.id)).pendingApprovals,
    ).toBeUndefined();
    await expect(
      next.service.respondToApproval(f.project.id, thread.id, approvalId, "allow"),
    ).rejects.toThrow("no longer");
    await next.service.close();
  }
});

test("a retry resumes automatically after relaunch without another message", async () => {
  const f = await fixture();
  spyOn(f.service as unknown as { retryDelay(): number }, "retryDelay").mockReturnValue(150);
  const thread = await f.start();
  f.runs[0].fail(new HarnessFailureError("Provider out of capacity", "unavailable"));
  await until(async () =>
    Boolean((await f.store.readThread(f.project.id, thread.id)).recovery?.retryAt),
  );
  await f.service.close();
  const next = await f.boot();
  await next.service.resumeUpdatedThreads();
  await until(() => f.runs.length === 2);
  expect((await next.store.readThread(f.project.id, thread.id)).messages).toHaveLength(1);
});

test("messages queued during a provider wait run after the original request recovers", async () => {
  const f = await fixture();
  spyOn(f.service as unknown as { retryDelay(): number }, "retryDelay").mockReturnValue(80);
  const thread = await f.start();
  f.runs[0].fail(new HarnessFailureError("Provider out of capacity", "unavailable"));
  await until(async () =>
    Boolean((await f.store.readThread(f.project.id, thread.id)).recovery?.retryAt),
  );
  await f.service.sendMessage({
    projectId: f.project.id,
    threadId: thread.id,
    text: "Then verify the work",
    delivery: "queue",
  });
  expect(f.runs).toHaveLength(1);
  await until(() => f.runs.length === 2);
  expect(f.runs[1].input.prompt).toContain("Continue the unfinished user request");
  f.runs[1].finish();
  await until(() => f.runs.length === 3);
  expect(f.runs[2].input.prompt).toContain("Then verify the work");
});

test("renaming during a retry wait preserves recovery without authorizing an edited portable prompt", async () => {
  const f = await fixture();
  spyOn(f.service as unknown as { retryDelay(): number }, "retryDelay").mockReturnValue(100);
  const thread = await f.start();
  f.runs[0].fail(new HarnessFailureError("Provider out of capacity", "unavailable"));
  await until(async () =>
    Boolean((await f.store.readThread(f.project.id, thread.id)).recovery?.retryAt),
  );
  await f.service.renameThread(f.project.id, thread.id, "Renamed while waiting");
  await until(() => f.runs.length === 2);
  expect((await f.store.readThread(f.project.id, thread.id)).title).toBe("Renamed while waiting");
  f.runs[1].fail(new HarnessFailureError("Provider out of capacity", "unavailable"));
  await until(async () =>
    Boolean((await f.store.readThread(f.project.id, thread.id)).recovery?.retryAt),
  );
  const path = join(f.project.path, ".tidy", "threads", `${thread.id}.json`);
  const portable = JSON.parse(await readFile(path, "utf8"));
  portable.messages[0].text = "An injected request";
  await writeFile(path, JSON.stringify(portable));
  await f.service.renameThread(f.project.id, thread.id, "Another title");
  await Bun.sleep(150);
  expect(f.runs).toHaveLength(2);
});

test("backoff increases, caps its base delay, and respects provider retry hints", async () => {
  const f = await fixture();
  const retry = f.service as unknown as { retryDelay(attempt: number, error?: string): number };
  const random = spyOn(Math, "random").mockReturnValue(0);
  try {
    expect(retry.retryDelay(1)).toBe(5000);
    expect(retry.retryDelay(3)).toBe(20000);
    expect(retry.retryDelay(100)).toBe(15 * 60_000);
    expect(retry.retryDelay(1, "Retry after: 120 seconds")).toBe(120_000);
    expect(retry.retryDelay(1, "Try again in 2 minutes")).toBe(120_000);
  } finally {
    random.mockRestore();
  }
});

test("portable edits cannot acquire crash recovery authority", async () => {
  const f = await fixture();
  const thread = await f.start();
  await f.service.close();
  const path = join(f.project.path, ".tidy", "threads", `${thread.id}.json`);
  const portable = JSON.parse(await readFile(path, "utf8"));
  portable.messages[0].text = "Different instructions from an untrusted file";
  portable.recovery = { reason: "restart", attempt: 0 };
  await writeFile(path, JSON.stringify(portable));
  const next = await f.boot();
  await next.service.resumeUpdatedThreads();
  expect(f.runs).toHaveLength(1);
  expect(await next.store.updateResumes.list()).toEqual([]);
});

test("parents and delegated workers resume under the durable scheduler without duplicate prompts", async () => {
  const f = await fixture();
  await f.service.initializeOrchestration();
  const parent = await f.start();
  const scope = {
    projectId: f.project.id,
    threadId: parent.id,
    designIds: [],
    writable: true,
    signal: new AbortController().signal,
  };
  const task = await f.service.tasks.delegate(scope, {
    request_id: randomUUID(),
    prompt: "Inspect the implementation",
  });
  await until(() => f.runs.length === 2);
  await f.service.close();
  const next = await f.boot();
  await next.service.initializeOrchestration();
  await next.service.resumeUpdatedThreads();
  await until(() => f.runs.length === 4);
  const child = await next.store.readThread(f.project.id, task.child_thread_id);
  expect(child.messages.filter((message) => message.role === "user")).toHaveLength(1);
  expect(child.messages[0].text).toBe("Inspect the implementation");
  expect((await next.service.tasks.store.get(task.task_id))?.state).toBe("running");
  await next.service.tasks.recover();
  await Bun.sleep(25);
  expect(f.runs).toHaveLength(4);
});

test("delegated provider retries stay scheduler-owned and can be cancelled during the wait", async () => {
  const f = await fixture();
  spyOn(f.service as unknown as { retryDelay(): number }, "retryDelay").mockReturnValue(40);
  await f.service.initializeOrchestration();
  const parent = await f.start();
  const scope = {
    projectId: f.project.id,
    threadId: parent.id,
    designIds: [],
    writable: true,
    signal: new AbortController().signal,
  };
  const task = await f.service.tasks.delegate(scope, {
    request_id: randomUUID(),
    prompt: "Inspect the implementation",
  });
  await until(() => f.runs.length === 2);
  f.runs[1].fail(new HarnessFailureError("Provider out of capacity", "unavailable"));
  await until(() => f.runs.length === 3);
  expect((await f.service.tasks.store.get(task.task_id))?.state).toBe("running");
  f.runs[2].fail(new HarnessFailureError("Still out of capacity", "unavailable"));
  await until(async () =>
    Boolean((await f.store.readThread(f.project.id, task.child_thread_id)).recovery?.retryAt),
  );
  await f.service.tasks.cancel(scope, { task_id: task.task_id });
  await until(async () => (await f.service.tasks.store.get(task.task_id))?.state === "cancelled");
  await Bun.sleep(75);
  expect(f.runs).toHaveLength(3);
});

for (const duringRename of [false, true]) {
  test(`a process crash ${duringRename ? "between the journal and thread rename" : "during an active turn"} recovers from private intent`, async () => {
    const f = await fixture();
    const script = `
      import {ProjectStore} from './src/main/workspace/project-store.ts';
      import {WorkspaceService} from './src/main/workspace/workspace-service.ts';
      const store = new ProjectStore(process.argv[1]); await store.initialize();
      const project = store.projects[0];
      let writes = 0;
      const write = store.writeAtomicFile.bind(store);
      store.writeAtomicFile = async (...args) => {
        if (args[0].includes('/threads/') && ++writes === 3 && ${duringRename}) process.exit(0);
        return write(...args);
      };
      const service = new WorkspaceService(store, (input) => {
        input.onUpdate({type:'session',id:'persisted-session'});
        input.onUpdate({type:'message',id:'partial',text:'Durable partial reply'});
        return {done:new Promise(()=>{}), deliveryState:'accepted', stop(){}};
      }, async()=>'/fixture/agent', async()=>{});
      await service.startThread({projectId:project.id,harness:'codex',prompt:'Recover this request',designIds:[]});
      await new Promise(resolve=>setTimeout(resolve,350)); await store.flush(); process.exit(0);
    `;
    const child = spawn(
      "node",
      ["--import", "tsx", "--input-type=module", "-e", script, f.directory],
      { cwd: new URL("../../..", import.meta.url), stdio: "pipe" },
    );
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    const code = await new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    expect(errors).toBe("");
    expect(code).toBe(0);
    const next = await f.boot();
    await next.service.resumeUpdatedThreads();
    expect(f.runs).toHaveLength(1);
    const thread = (await next.store.snapshot(f.project.id)).threads[0];
    expect(thread.status).toBe("running");
    expect(
      (await next.store.readThread(f.project.id, thread.id)).messages.filter(
        (message) => message.role === "user",
      ),
    ).toHaveLength(1);
  }, 15000);
}
