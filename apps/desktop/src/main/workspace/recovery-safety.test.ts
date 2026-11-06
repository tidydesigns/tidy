import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread } from "../../shared/contracts/desktop";
import type { startHarness } from "../harnesses/harnesses";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function preparationGate() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    async locate() {
      entered.resolve();
      await released.promise;
      return "/fixture/agent";
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tidy-recovery-safety-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "private");
  const runs: Array<Parameters<typeof startHarness>[0]> = [];
  async function boot(preparation?: ReturnType<typeof preparationGate>) {
    const store = new ProjectStore(directory);
    await store.initialize();
    await store.recover();
    const service = new WorkspaceService(
      store,
      (input) => {
        const done = Promise.withResolvers<void>();
        runs.push(input);
        input.onUpdate({ type: "session", id: input.sessionId ?? randomUUID() });
        return {
          done: done.promise,
          deliveryState: "accepted",
          stop() {
            done.resolve();
          },
        };
      },
      preparation ? () => preparation.locate() : async () => "/fixture/agent",
      async () => {},
    );
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      preparation?.release();
      await service.close();
    };
    cleanups.push(close);
    return { store, service, close };
  }
  const initial = await boot();
  await mkdir(join(root, "project"));
  const { project } = await initial.store.open(join(root, "project"));
  async function seedThread(prompt: string, status: Thread["status"] = "interrupted") {
    const thread: Thread = {
      id: randomUUID(),
      projectId: project.id,
      title: prompt,
      harness: "codex",
      revision: 0,
      designIds: [],
      messages: [{ id: randomUUID(), role: "user", text: prompt }],
      status,
      updatedAt: new Date().toISOString(),
    };
    await initial.store.writeThread(thread);
    return initial.store.readThread(project.id, thread.id);
  }
  return { ...initial, project, seedThread, boot, runs };
}

test("Stop during async preparation leaves no private recovery authority after reopening the backend", async () => {
  const f = await fixture();
  const thread = await f.seedThread("Earlier completed request", "completed");
  await f.close();
  const gate = preparationGate();
  const backend = await f.boot(gate);
  const sending = backend.service.sendMessage({
    projectId: f.project.id,
    threadId: thread.id,
    text: "A request stopped before submission",
  });
  try {
    await gate.entered;
    expect(await backend.store.updateResumes.list()).toHaveLength(1);
    await backend.service.stopThread(f.project.id, thread.id);
    gate.release();
    await sending;
    await backend.store.flush();
    expect(f.runs).toHaveLength(0);
    expect((await backend.store.readThread(f.project.id, thread.id)).status).toBe("stopped");
    expect(await backend.store.updateResumes.list()).toEqual([]);
    await backend.close();

    const reopened = await f.boot();
    await reopened.service.resumeUpdatedThreads();
    expect(f.runs).toHaveLength(0);
    expect(await reopened.store.updateResumes.list()).toEqual([]);
    expect((await reopened.store.readThread(f.project.id, thread.id)).status).toBe("stopped");
  } finally {
    gate.release();
    await sending.catch(() => {});
  }
});

test("queued recovery rechecks scheduler authorization after a grant is revoked during async preparation", async () => {
  const f = await fixture();
  const thread = await f.seedThread("Earlier request");
  const queued = { id: randomUUID(), text: "Run the queued assignment" };
  thread.queuedMessages = [queued];
  await f.store.trustQueuedMessage(thread, queued);
  await f.store.writeThread(thread);
  await f.store.updateResumes.stage([
    {
      projectId: f.project.id,
      threadId: thread.id,
      signature: await f.store.updateResumeSignature(
        await f.store.readThread(f.project.id, thread.id),
        f.project.path,
      ),
      automaticQueue: false,
      reason: "restart",
      submission: { messageId: queued.id, state: "not-submitted" },
    },
  ]);
  await f.close();

  const gate = preparationGate();
  const backend = await f.boot(gate);
  await backend.service.initializeOrchestration();
  await backend.service.setThreadWorkPermission(f.project.id, thread.id, true);
  const grant = backend.service.tasks.store.receiverGrant(f.project.id, thread.id);
  expect(grant).toBeDefined();
  const scheduler = {
    async authorize() {
      if (backend.service.tasks.store.receiverGrant(f.project.id, thread.id) !== grant)
        throw new Error("The incoming-work grant was revoked.");
    },
  };
  const authorize = spyOn(scheduler, "authorize");
  cleanups.push(() => authorize.mockRestore());
  const recovery = backend.service.resumeThread(f.project.id, thread.id, scheduler.authorize);
  try {
    await gate.entered;
    const checksBeforeRevocation = authorize.mock.calls.length;
    expect(checksBeforeRevocation).toBeGreaterThan(0);
    await backend.service.setThreadWorkPermission(f.project.id, thread.id, false);
    gate.release();
    await recovery;

    expect(authorize.mock.calls.length).toBeGreaterThan(checksBeforeRevocation);
    expect(f.runs).toHaveLength(0);
    const saved = await backend.store.readThread(f.project.id, thread.id);
    expect(saved.queuedMessages?.map((message) => message.id)).toContain(queued.id);
    expect(saved.messages.some((message) => message.id === queued.id)).toBe(false);
  } finally {
    gate.release();
    await recovery.catch(() => {});
  }
});

test("an unreadable checkpointed thread does not block a later recovery batch or scheduler recovery", async () => {
  const f = await fixture();
  const threads: Thread[] = [];
  for (let index = 0; index < 5; index++)
    threads.push(await f.seedThread(`Recover request ${index + 1}`));
  await f.store.updateResumes.stage(
    await Promise.all(
      threads.map(async (thread) => ({
        projectId: f.project.id,
        threadId: thread.id,
        signature: await f.store.updateResumeSignature(thread, f.project.path),
        automaticQueue: false,
        reason: "restart" as const,
        submission: { messageId: thread.messages[0].id, state: "accepted" as const },
      })),
    ),
  );
  await f.close();
  await writeFile(await f.store.storagePath(f.project.id, "threads", threads[0].id), "{invalid");

  const backend = await f.boot();
  const recoverScheduler = spyOn(backend.service.tasks, "recover");
  cleanups.push(() => recoverScheduler.mockRestore());
  await expect(backend.service.resumeUpdatedThreads()).resolves.toBeUndefined();

  expect(f.runs).toHaveLength(4);
  expect(f.runs.some((input) => input.prompt.includes(threads[4].messages[0].text))).toBe(true);
  expect((await backend.store.readThread(f.project.id, threads[4].id)).status).toBe("running");
  expect(recoverScheduler).toHaveBeenCalledTimes(1);
});
