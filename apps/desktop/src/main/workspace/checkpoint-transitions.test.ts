import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread } from "../../shared/contracts/desktop";
import { ProjectStore } from "./project-store";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tidy-checkpoint-transition-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "private");
  const store = new ProjectStore(directory);
  await store.initialize();
  await mkdir(join(root, "project"));
  const { project } = await store.open(join(root, "project"));
  const thread: Thread = {
    id: randomUUID(),
    projectId: project.id,
    title: "Accepted work",
    harness: "codex",
    revision: 0,
    designIds: [],
    sessionId: "old-session",
    settings: { permissionMode: "default" },
    messages: [{ id: randomUUID(), role: "user", text: "Finish my accepted request" }],
    status: "running",
    updatedAt: new Date().toISOString(),
  };
  return { store, thread, directory, project };
}

for (const phase of ["before-authority", "after-authority", "after-journal"] as const) {
  test(`session authority remains recoverable after a crash ${phase}`, async () => {
    const f = await fixture();
    f.store.trackRun(f.thread.id, () => ({
      reason: "restart",
      automaticQueue: false,
      submission: { messageId: f.thread.messages[0].id, state: "accepted" },
    }));
    await f.store.writeThread(f.thread);
    const checkpoint = f.store.updateResumes.checkpoint.bind(f.store.updateResumes);
    let calls = 0;
    const failure = spyOn(f.store.updateResumes, "checkpoint").mockImplementation(
      async (...args) => {
        calls++;
        if (phase === "after-authority" && calls === 2) throw new Error("Simulated process loss");
        await checkpoint(...args);
        if (
          (phase === "before-authority" && calls === 1) ||
          (phase === "after-journal" && calls === 2)
        )
          throw new Error("Simulated process loss");
      },
    );
    cleanup.push(() => failure.mockRestore());
    await expect(
      f.store.writeThread({
        ...f.thread,
        sessionId: "new-session",
        revision: 1,
        messages: [
          ...f.thread.messages,
          { id: randomUUID(), role: "assistant", text: "More progress" },
        ],
      }),
    ).rejects.toThrow("Simulated");
    failure.mockRestore();
    f.store.untrackRun(f.thread.id);
    const reopened = new ProjectStore(f.directory);
    await reopened.initialize();
    const saved = await reopened.readThread(f.project.id, f.thread.id);
    const [entry] = await reopened.updateResumes.list();
    expect([entry.signature, entry.previousSignature]).toContain(
      await reopened.updateResumeSignature(saved, f.project.path),
    );
    await reopened.recover();
    expect((await reopened.readThread(f.project.id, f.thread.id)).error).toBeUndefined();
    expect((await reopened.updateResumes.list())[0].submission?.messageId).toBe(
      f.thread.messages[0].id,
    );
  });
}

test("an imported running thread cannot retain a recovery notice without private intent", async () => {
  const f = await fixture();
  await f.store.writeThread({
    ...f.thread,
    recovery: {
      reason: "provider",
      attempt: 2,
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  await f.store.recover();
  const saved = await f.store.readThread(f.project.id, f.thread.id);
  expect(saved.status).toBe("interrupted");
  expect(saved.recovery).toBeUndefined();
  expect(await f.store.updateResumes.list()).toEqual([]);
});

test("active checkpoints reuse only the previous native snapshot hash", async () => {
  const f = await fixture();
  f.store.trackRun(f.thread.id, () => ({ automaticQueue: false }));
  await f.store.writeThread(f.thread);
  const saved = await f.store.readThread(f.project.id, f.thread.id);
  const hashes = spyOn(f.store, "updateResumeSignature");
  cleanup.push(() => hashes.mockRestore());
  const next = { ...saved, revision: 1 };
  await f.store.writeThread(next);
  expect(hashes).toHaveBeenCalledTimes(1);
  const [entry] = await f.store.updateResumes.list();
  expect(entry.previousSignature).toBe(await f.store.updateResumeSignature(saved, f.project.path));
  expect(entry.signature).toBe(await f.store.updateResumeSignature(next, f.project.path));
  hashes.mockClear();
  await f.store.writeThread({ ...next, revision: 2, settings: { permissionMode: "auto" } });
  // New authority needs the current hash and the old snapshot under that new authority.
  expect(hashes).toHaveBeenCalledTimes(2);
});

test("a completed old write cannot populate a newly tracked run's snapshot cache", async () => {
  const f = await fixture();
  const gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  f.store.trackRun(f.thread.id, () => ({ automaticQueue: false }));
  const checkpoint = f.store.updateResumes.checkpoint.bind(f.store.updateResumes);
  const blocked = spyOn(f.store.updateResumes, "checkpoint").mockImplementation(async (...args) => {
    entered.resolve();
    await gate.promise;
    await checkpoint(...args);
  });
  cleanup.push(() => blocked.mockRestore());
  const writing = f.store.writeThread(f.thread);
  await entered.promise;
  f.store.untrackRun(f.thread.id);
  f.store.trackRun(f.thread.id, () => ({ automaticQueue: false }));
  gate.resolve();
  await writing;
  blocked.mockRestore();
  expect((Reflect.get(f.store, "runSnapshots") as Map<string, unknown>).has(f.thread.id)).toBe(
    false,
  );
  const hashes = spyOn(f.store, "updateResumeSignature");
  cleanup.push(() => hashes.mockRestore());
  const next = { ...f.thread, revision: 1 };
  await f.store.writeThread(next);
  expect(hashes).toHaveBeenCalledTimes(1);
});
