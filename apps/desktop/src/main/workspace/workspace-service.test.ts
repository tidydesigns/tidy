import { HarnessSkills, type SkillAdapter } from "../harnesses/harness-skills";
import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";
import type { startHarness, HarnessUpdate } from "../harnesses/harnesses";
import type { DesktopEvent, Thread } from "../../shared/contracts/desktop";
import {
  MAX_TOOL_ACTIVITIES,
  MAX_TOOL_LOG_CHARACTERS,
  toolLogSize,
} from "../../shared/contracts/tool-activity";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  configure: ConstructorParameters<typeof WorkspaceService>[3] = async () => {},
  holdPreparation = false,
  skills?: HarnessSkills,
  holdStop = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "tidy-workspace-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new ProjectStore(join(directory, "app"));
  await store.initialize();
  const root = join(directory, "project");
  await mkdir(root);
  const snapshot = await store.open(root);
  const runs: Array<{
    input: Parameters<typeof startHarness>[0];
    complete: () => void;
    stopped: boolean;
    stopping: Promise<void>;
    decisions: Array<{ id: string; decision: string }>;
  }> = [];
  let prepared!: () => void;
  let resumePreparation!: () => void;
  const preparation = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  const preparationGate = new Promise<void>((resolve) => {
    resumePreparation = resolve;
  });
  const service = new WorkspaceService(
    store,
    (input) => {
      let complete!: () => void;
      const done = new Promise<void>((resolve) => {
        complete = resolve;
      });
      let stopped!: () => void;
      const stopping = new Promise<void>((resolve) => {
        stopped = resolve;
      });
      const run = {
        input,
        stopping,
        complete,
        stopped: false,
        decisions: [] as Array<{ id: string; decision: string }>,
      };
      runs.push(run);
      return {
        done,
        respondToApproval(id, decision) {
          if (run.stopped) return false;
          run.decisions.push({ id, decision });
          return true;
        },
        stop() {
          run.stopped = true;
          stopped();
          if (!holdStop) complete();
        },
      };
    },
    async () => {
      prepared();
      if (holdPreparation) await preparationGate;
      return "/fixture/harness";
    },
    configure,
    skills,
  );
  cleanups.push(async () => {
    resumePreparation();
    await service.close();
  });
  return {
    directory,
    store,
    service,
    project: snapshot.project,
    runs,
    preparation,
    resumePreparation,
  };
}
function finished(service: WorkspaceService, threadId: string) {
  return new Promise<Thread>((resolve) => {
    const unsubscribe = service.subscribe((event) => {
      if (
        event.type === "thread" &&
        event.thread.id === threadId &&
        event.thread.status !== "running"
      ) {
        unsubscribe();
        resolve(event.thread);
      }
    });
  });
}

test("harness maintenance reserves an idle CLI, blocks its turns and leaves other harnesses usable", async () => {
  const { service, project, runs } = await fixture();
  const release = service.reserveHarnessUpdate("codex");
  expect(release).not.toBeNull();
  expect(service.reserveHarnessUpdate("codex")).toBeNull();
  await expect(
    service.startThread({
      projectId: project.id,
      harness: "codex",
      prompt: "Blocked",
      designIds: [],
    }),
  ).rejects.toThrow("updating");
  const other = await service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "Other CLI",
    designIds: [],
  });
  expect(service.reserveHarnessUpdate("claude")).toBeNull();
  const complete = finished(service, other.id);
  runs[0].complete();
  await complete;
  release!();
  const next = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "After update",
    designIds: [],
  });
  expect(next.status).toBe("running");
});

test("a preparing turn prevents maintenance from racing harness discovery", async () => {
  const { service, project, preparation, resumePreparation } = await fixture(undefined, true);
  const preparing = service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Starting",
    designIds: [],
  });
  await preparation;
  expect(service.reserveHarnessUpdate("codex")).toBeNull();
  resumePreparation();
  await preparing;
  expect(service.reserveHarnessUpdate("codex")).toBeNull();
});

test("preparing another harness does not hold up an update", async () => {
  const { service, project, preparation, resumePreparation } = await fixture(undefined, true);
  const preparing = service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "Preparing",
    designIds: [],
  });
  await preparation;
  const release = service.reserveHarnessUpdate("codex");
  expect(release).not.toBeNull();
  expect(service.reserveHarnessUpdate("claude")).toBeNull();
  resumePreparation();
  await preparing;
  release!();
});

test("idle conversations remain open and other harnesses may keep running during an update", async () => {
  const { service, store, project, runs } = await fixture();
  const codex = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "First reply",
    designIds: [],
  });
  await service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "Other response",
    designIds: [],
  });
  const complete = finished(service, codex.id);
  runs[0].complete();
  await complete;
  const release = service.reserveHarnessUpdate("codex");
  expect(release).not.toBeNull();
  expect((await store.readThread(project.id, codex.id)).doneAt).toBeUndefined();
  expect(runs[1].stopped).toBe(false);
  release!();
});

test("background-safe native updates leave an active response untouched and guard subsequent launches", async () => {
  const { service, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "Keep replying",
    designIds: [],
  });
  const release = service.reserveHarnessUpdate("claude", { allowActiveRuns: true });
  expect(release).not.toBeNull();
  expect((await service.readThread(project.id, thread.id)).status).toBe("running");
  expect(runs[0].stopped).toBe(false);
  await expect(
    service.startThread({
      projectId: project.id,
      harness: "claude",
      prompt: "Next launch",
      designIds: [],
    }),
  ).rejects.toThrow("updating");
  release!();
});

test("background-safe updates wait for Claude preparation before overlapping its active response", async () => {
  const { service, project, runs, preparation, resumePreparation } = await fixture(undefined, true);
  const preparing = service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "Preparing a response",
    designIds: [],
  });
  await preparation;
  expect(service.reserveHarnessUpdate("claude", { allowActiveRuns: true })).toBeNull();
  resumePreparation();
  const thread = await preparing;
  const release = service.reserveHarnessUpdate("claude", { allowActiveRuns: true });
  expect(release).not.toBeNull();
  expect(runs).toHaveLength(1);
  expect(runs[0].stopped).toBe(false);
  expect((await service.readThread(project.id, thread.id)).status).toBe("running");
  release!();
});

test("queued follow-ups are retained when an update blocks delivery and can be sent after installation", async () => {
  const { service, project, runs, store } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "First",
    designIds: [],
  });
  const complete = finished(service, thread.id);
  runs[0].complete();
  await complete;
  const release = service.reserveHarnessUpdate("claude");
  expect(release).not.toBeNull();
  const messageId = randomUUID();
  const queued = await service.sendMessage({
    projectId: project.id,
    threadId: thread.id,
    messageId,
    text: "Next response",
    delivery: "queue",
  });
  expect(queued.queueError).toContain("updating");
  expect(queued.queuedMessages?.map((message) => message.id)).toEqual([messageId]);
  expect((await store.readThread(project.id, thread.id)).queuedMessages?.[0].text).toBe(
    "Next response",
  );
  expect(runs).toHaveLength(1);
  release!();
  const sent = await service.updateMessageQueue({
    projectId: project.id,
    threadId: thread.id,
    action: { kind: "steer", messageId },
  });
  expect(sent.status).toBe("running");
  expect(sent.queuedMessages).toHaveLength(0);
  expect(runs).toHaveLength(2);
});

test("update preparation checkpoints a running harness and can reopen the workspace after restart fails", async () => {
  const { service, store, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "Before update",
    designIds: [],
  });
  runs[0].input.onUpdate({ type: "message", id: "reply", text: "Persist this reply" });
  const restore = await service.prepareUpdate();
  expect(runs[0].stopped).toBe(true);
  const saved = await store.readThread(project.id, thread.id);
  expect(saved.status).not.toBe("running");
  expect(saved.messages.some((message) => message.text === "Persist this reply")).toBe(true);
  await expect(
    service.startThread({
      projectId: project.id,
      harness: "claude",
      prompt: "Blocked during update",
      designIds: [],
    }),
  ).rejects.toThrow("closing");
  restore();
  const next = await service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "Continue after failure",
    designIds: [],
  });
  expect(next.status).toBe("running");
  expect(runs.length).toBe(2);
});

test("a failed update flush releases the workspace instead of leaving it permanently closed", async () => {
  const { service, store, project } = await fixture();
  const flush = store.flush.bind(store);
  store.flush = () => Promise.reject(new Error("disk failure"));
  try {
    await expect(service.prepareUpdate()).rejects.toThrow("disk failure");
  } finally {
    store.flush = flush;
  }
  const thread = await service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "Still usable",
    designIds: [],
  });
  expect(thread.status).toBe("running");
});

for (const fails of [false, true]) {
  test(`ordinary quit keeps work blocked when pending update preparation ${fails ? "fails" : "recovers"}`, async () => {
    const { service, store, project, runs } = await fixture();
    const originalFlush = store.flush.bind(store);
    let finishUpdate!: () => void;
    let failUpdate!: (error: Error) => void;
    let finishQuit!: () => void;
    let enteredUpdate!: () => void;
    let enteredQuit!: () => void;
    const updateEntered = new Promise<void>((resolve) => {
      enteredUpdate = resolve;
    });
    const quitEntered = new Promise<void>((resolve) => {
      enteredQuit = resolve;
    });
    const updateFlush = new Promise<void>((resolve, reject) => {
      finishUpdate = resolve;
      failUpdate = reject;
    });
    const quitFlush = new Promise<void>((resolve) => {
      finishQuit = resolve;
    });
    let flushes = 0;
    store.flush = () => {
      if (++flushes === 1) {
        enteredUpdate();
        return updateFlush;
      }
      enteredQuit();
      return quitFlush;
    };
    const preparing = service.prepareUpdate().then(
      (restore) => ({ restore }),
      (error: unknown) => ({ error }),
    );
    await updateEntered;
    const quitting = service.close();
    try {
      await quitEntered;
      if (fails) failUpdate(new Error("update flush failed"));
      else finishUpdate();
      const prepared = await preparing;
      if ("restore" in prepared) prepared.restore();
      else expect(String(prepared.error)).toContain("update flush failed");
      await expect(
        service.startThread({
          projectId: project.id,
          harness: "claude",
          prompt: "Must stay blocked",
          designIds: [],
        }),
      ).rejects.toThrow("closing");
      expect(runs.length).toBe(0);
      finishQuit();
      await quitting;
      await expect(service.prepareUpdate()).rejects.toThrow("closing");
    } finally {
      finishUpdate();
      finishQuit();
      store.flush = originalFlush;
      await preparing;
      await quitting;
    }
  });
}

test("an old update recovery callback cannot release a newer preparation", async () => {
  const { service, project } = await fixture();
  const first = await service.prepareUpdate();
  first();
  const second = await service.prepareUpdate();
  first();
  await expect(
    service.startThread({
      projectId: project.id,
      harness: "claude",
      prompt: "Still updating",
      designIds: [],
    }),
  ).rejects.toThrow("closing");
  second();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "Recovered",
    designIds: [],
  });
  expect(thread.status).toBe("running");
});

for (const shutdown of ["update", "quit"] as const) {
  for (const stage of ["done read", "settings read", "settings validation"] as const) {
    test(`${shutdown} rejects metadata writes delayed at ${stage}`, async () => {
      let paused = false;
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { service, store, project, runs } = await fixture(async () => {
        if (paused && stage === "settings validation") {
          enter();
          await gate;
        }
      });
      const thread = await service.startThread({
        projectId: project.id,
        harness: "claude",
        prompt: "Existing thread",
        designIds: [],
      });
      const completed = finished(service, thread.id);
      runs[0].complete();
      await completed;
      await store.flush();
      const before = await store.readThread(project.id, thread.id);
      const read = store.readThread.bind(store);
      const write = store.writeThread.bind(store);
      let writes = 0;
      store.readThread = async (...args) => {
        const value = await read(...args);
        if (paused && stage !== "settings validation") {
          enter();
          await gate;
        }
        return value;
      };
      store.writeThread = (value) => {
        writes++;
        return write(value);
      };
      paused = true;
      const edit = (
        stage === "done read"
          ? service.setThreadDone(project.id, thread.id, true)
          : service.setThreadSettings(project.id, thread.id, { model: "new-model" })
      ).then(
        (value) => value,
        (error: unknown) => error,
      );
      let restore: (() => void) | undefined;
      try {
        await entered;
        if (shutdown === "update") restore = await service.prepareUpdate();
        else await service.close();
        release();
        expect(String(await edit)).toContain("closing");
        expect(writes).toBe(0);
        expect(await read(project.id, thread.id)).toEqual(before);
        paused = false;
        if (restore) {
          restore();
          // Rejection must also release the per-thread guard so retry remains usable.
          expect((await service.setThreadDone(project.id, thread.id, true)).doneAt).toBeDefined();
        }
      } finally {
        release();
        await edit;
        store.readThread = read;
        store.writeThread = write;
        restore?.();
      }
    });
  }
}

test("design references reach the harness and follow-up messages resume the same session", async () => {
  const { service, store, project, runs } = await fixture();
  const design = await store.createDesign(project.id);
  const thread = await service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "Implement this design",
    designIds: [design.id],
  });
  expect(runs[0].input.cwd).toBe(project.path);
  expect(runs[0].input.prompt).toContain(design.path);
  const sessionId = randomUUID();
  const updates: HarnessUpdate[] = [
    { type: "session", id: sessionId },
    { type: "message", id: "native-message", text: "Hello ", append: true },
    { type: "message", id: "native-message", text: "project", append: true },
    { type: "message", id: "native-message", text: "Hello project" },
  ];
  updates.forEach(runs[0].input.onUpdate);
  const completion = finished(service, thread.id);
  runs[0].complete();
  const completed = await completion;
  expect(completed.messages.map((message) => message.text)).toEqual([
    "Implement this design",
    "Hello project",
  ]);
  await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "Now add tests" });
  expect(runs[1].input.sessionId).toBe(sessionId);
  expect((await service.readThread(project.id, thread.id)).messages[2].text).toBe("Now add tests");
});

test("projects remain isolated, concurrent turns are rejected and stopping fences late output", async () => {
  const { directory, service, store, project, runs } = await fixture();
  const root = join(directory, "second");
  await mkdir(root);
  const other = (await store.open(root)).project;
  const first = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "First",
    designIds: [],
  });
  const second = await service.startThread({
    projectId: other.id,
    harness: "claude",
    prompt: "Second",
    designIds: [],
  });
  await expect(service.readThread(other.id, first.id)).rejects.toThrow("another project");
  await expect(service.stopThread(other.id, first.id)).rejects.toThrow("another project");
  await expect(
    service.sendMessage({ projectId: project.id, threadId: first.id, text: "Duplicate" }),
  ).rejects.toThrow("already running");
  const completion = finished(service, first.id);
  await service.stopThread(project.id, first.id);
  runs[0].input.onUpdate({ type: "message", id: "late", text: "should not appear" });
  const stopped = await completion;
  expect(stopped.status).toBe("stopped");
  expect(stopped.messages.some((message) => message.text === "should not appear")).toBe(false);
  expect((await service.readThread(other.id, second.id)).status).toBe("running");
  expect(runs[1].stopped).toBe(false);
});

test("closing during harness discovery does not launch a process after shutdown", async () => {
  const { store, project } = await fixture();
  let release!: (path: string) => void;
  let locating!: () => void;
  const located = new Promise<void>((resolve) => {
    locating = resolve;
  });
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  let launched = false;
  const service = new WorkspaceService(
    store,
    () => {
      launched = true;
      throw new Error("Must not launch");
    },
    () => {
      locating();
      return gate;
    },
  );
  const request = service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Work",
    designIds: [],
  });
  await located;
  await service.close();
  release("/fixture/harness");
  await expect(request).rejects.toThrow("closing");
  expect(launched).toBe(false);
});

test("stopping during the first disk checkpoint prevents process launch", async () => {
  const { store, service, project, runs } = await fixture();
  const original = store.writeThread.bind(store);
  let release!: () => void;
  let admitted!: (thread: Thread) => void;
  const admission = new Promise<Thread>((resolve) => {
    admitted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  store.writeThread = async (value) => {
    if (value.status === "running") {
      admitted(value);
      await gate;
    }
    return original(value);
  };
  const request = service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Work",
    designIds: [],
  });
  const thread = await admission;
  await service.stopThread(project.id, thread.id);
  release();
  expect((await request).status).toBe("stopped");
  expect(runs.length).toBe(0);
  expect((await store.readThread(project.id, thread.id)).status).toBe("stopped");
});

test("Done is an explicit persisted thread state, independent of a finished harness turn", async () => {
  const { directory, service, store, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Finish the design",
    designIds: [],
  });
  const sessionId = randomUUID();
  runs[0].input.onUpdate({ type: "session", id: sessionId });
  const completion = finished(service, thread.id);
  runs[0].complete();
  const completed = await completion;
  expect(completed.status).toBe("completed");
  expect(completed.doneAt).toBeUndefined();
  const marked = await service.setThreadDone(project.id, thread.id, true);
  expect(marked.doneAt).toBeDefined();
  expect(marked.updatedAt).toBe(completed.updatedAt);
  expect(marked.revision).toBe(completed.revision + 1);
  expect((await service.setThreadDone(project.id, thread.id, true)).revision).toBe(marked.revision);
  const reopenedStore = new ProjectStore(join(directory, "app"));
  await reopenedStore.initialize();
  expect((await reopenedStore.snapshot(project.id)).threads[0].doneAt).toBe(marked.doneAt);
  await expect(
    service.sendMessage({ projectId: project.id, threadId: thread.id, text: "Continue" }),
  ).rejects.toThrow("Reopen");
  expect(runs).toHaveLength(1);
  await service.setThreadDone(project.id, thread.id, false);
  expect((await store.readThread(project.id, thread.id)).doneAt).toBeUndefined();
  await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "Continue" });
  expect(runs[1].input.sessionId).toBe(sessionId);
});

test("Done stops a running thread, cancels approvals, and preserves queued messages for Reopen", async () => {
  const { service, store, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Work",
    designIds: [],
  });
  await service.sendMessage({
    projectId: project.id,
    threadId: thread.id,
    text: "Next task",
    delivery: "queue",
  });
  const approvalId = randomUUID();
  runs[0].input.onUpdate({
    type: "approval",
    request: { id: approvalId, title: "Allow command?", choices: ["allow", "deny"] },
  });
  const events: Thread[] = [];
  const unsubscribe = service.subscribe((event) => {
    if (event.type === "thread" && event.thread.id === thread.id)
      events.push(structuredClone(event.thread));
  });
  const marked = await service.setThreadDone(project.id, thread.id, true);
  unsubscribe();
  expect(runs[0].stopped).toBe(true);
  expect(marked.status).toBe("stopped");
  expect(marked.doneAt).toBeDefined();
  expect(marked.activity).toBeUndefined();
  expect(marked.pendingApprovals).toBeUndefined();
  await expect(
    service.respondToApproval(project.id, thread.id, approvalId, "allow"),
  ).rejects.toThrow("no longer");
  expect(runs[0].decisions).toHaveLength(0);
  expect(marked.queuedMessages?.map((item) => item.text)).toEqual(["Next task"]);
  expect(runs).toHaveLength(1);
  expect(events.every((value) => value.doneAt !== undefined)).toBe(true);
  expect((await store.readThread(project.id, thread.id)).doneAt).toBe(marked.doneAt);
  const reopened = await service.setThreadDone(project.id, thread.id, false);
  expect(reopened.doneAt).toBeUndefined();
  expect(reopened.status).toBe("stopped");
  expect(runs).toHaveLength(1);
});

test("Done waits for process termination before persisting the stopped thread", async () => {
  const { service, store, project, runs } = await fixture(undefined, false, undefined, true);
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Work",
    designIds: [],
  });
  const done = service.setThreadDone(project.id, thread.id, true);
  try {
    await runs[0].stopping;
    expect((await store.readThread(project.id, thread.id)).doneAt).toBeUndefined();
  } finally {
    runs[0].complete();
  }
  const marked = await done;
  expect(marked.status).toBe("stopped");
  expect(marked.doneAt).toBeDefined();
});

test("Done during preparation cancels the launch and persists a stopped thread", async () => {
  const { service, store, project, runs, preparation, resumePreparation } = await fixture(
    undefined,
    true,
  );
  const threadId = randomUUID();
  const start = service.startThread({
    projectId: project.id,
    threadId,
    harness: "codex",
    prompt: "Work",
    designIds: [],
  });
  await preparation;
  const done = service.setThreadDone(project.id, threadId, true);
  resumePreparation();
  await start;
  const marked = await done;
  expect(runs).toHaveLength(0);
  expect(marked.status).toBe("stopped");
  expect(marked.doneAt).toBeDefined();
  expect((await store.readThread(project.id, threadId)).doneAt).toBe(marked.doneAt);
});

test("Done does not stop another project's run or publish Done after a failed checkpoint", async () => {
  const { directory, service, store, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Work",
    designIds: [],
  });
  const otherRoot = join(directory, "other");
  await mkdir(otherRoot);
  const other = (await store.open(otherRoot)).project;
  await expect(service.setThreadDone(other.id, thread.id, true)).rejects.toThrow("another project");
  expect(runs[0].stopped).toBe(false);
  const write = store.writeThread.bind(store);
  store.writeThread = async () => {
    throw new Error("Disk full");
  };
  const events: Thread[] = [];
  const unsubscribe = service.subscribe((event) => {
    if (event.type === "thread") events.push(structuredClone(event.thread));
  });
  try {
    await expect(service.setThreadDone(project.id, thread.id, true)).rejects.toThrow("Disk full");
    expect(runs[0].stopped).toBe(true);
    expect(events.every((value) => value.doneAt === undefined)).toBe(true);
    expect((await store.readThread(project.id, thread.id)).doneAt).toBeUndefined();
  } finally {
    store.writeThread = write;
    unsubscribe();
  }
});

test("thread completion rejects project mismatches and never publishes a failed disk write", async () => {
  const { directory, service, store, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "One task",
    designIds: [],
  });
  const completion = finished(service, thread.id);
  runs[0].complete();
  await completion;
  const otherRoot = join(directory, "other");
  await mkdir(otherRoot);
  const other = (await store.open(otherRoot)).project;
  await expect(service.setThreadDone(other.id, thread.id, true)).rejects.toThrow();
  const write = store.writeThread.bind(store);
  store.writeThread = async () => {
    throw new Error("Disk full");
  };
  const events: unknown[] = [];
  const unsubscribe = service.subscribe((event) => events.push(event));
  await expect(service.setThreadDone(project.id, thread.id, true)).rejects.toThrow("Disk full");
  expect(events).toHaveLength(0);
  expect((await store.readThread(project.id, thread.id)).doneAt).toBeUndefined();
  store.writeThread = write;
  unsubscribe();
});

test("model settings persist and resume the same session; usage respects per-turn and cumulative reports", async () => {
  const { service, store, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "First",
    designIds: [],
    settings: { model: "fixture-codex", effort: "high" },
  });
  expect(runs[0].input.settings).toEqual({ model: "fixture-codex", effort: "high" });
  const sessionId = randomUUID();
  runs[0].input.onUpdate({ type: "session", id: sessionId });
  runs[0].input.onUpdate({
    type: "usage",
    usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 },
    cumulative: false,
  });
  const completion = finished(service, thread.id);
  runs[0].complete();
  await completion;
  await service.setThreadSettings(project.id, thread.id, {
    model: "another-model",
    effort: "medium",
  });
  expect((await store.readThread(project.id, thread.id)).settings?.model).toBe("another-model");
  await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "Second" });
  expect(runs[1].input.sessionId).toBe(sessionId);
  expect(runs[1].input.settings?.effort).toBe("medium");
  await expect(
    service.setThreadSettings(project.id, thread.id, { model: "third-model" }),
  ).rejects.toThrow("finish");
  runs[1].input.onUpdate({
    type: "usage",
    usage: { inputTokens: 150, cachedInputTokens: 30, outputTokens: 15 },
    cumulative: false,
  });
  runs[1].input.onUpdate({
    type: "usage",
    usage: { inputTokens: 150, cachedInputTokens: 30, outputTokens: 15 },
    cumulative: false,
  });
  expect((await service.readThread(project.id, thread.id)).usage?.inputTokens).toBe(250);
  runs[1].input.onUpdate({
    type: "usage",
    usage: { inputTokens: 300, cachedInputTokens: 50, outputTokens: 30, costUSD: 0.1 },
    cumulative: true,
  });
  runs[1].input.onUpdate({
    type: "usage",
    usage: { inputTokens: 300, cachedInputTokens: 50, outputTokens: 30, costUSD: 0.1 },
    cumulative: true,
  });
  expect((await service.readThread(project.id, thread.id)).usage).toEqual({
    inputTokens: 300,
    cachedInputTokens: 50,
    outputTokens: 30,
    costUSD: 0.1,
  });
});

test("attachment-only turns keep files with the message and send images to the harness", async () => {
  const { store, service, project, runs } = await fixture();
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSkcAAAAASUVORK5CYII=";
  const image = await store.addAttachment(
    project.id,
    "Screenshot.png",
    `data:image/png;base64,${png}`,
  );
  const file = await store.addAttachment(
    project.id,
    "Notes.txt",
    `data:text/plain;base64,${Buffer.from("Project notes").toString("base64")}`,
  );
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "",
    designIds: [],
    attachmentIds: [image.id, file.id],
  });
  expect(thread.title).toBe("Screenshot.png");
  expect(thread.messages[0].attachments?.map((file) => file.name)).toEqual([
    "Screenshot.png",
    "Notes.txt",
  ]);
  expect(JSON.stringify(thread)).not.toContain(png);
  expect(runs[0].input.images?.[0].data).toBe(png);
  expect(runs[0].input.prompt).toContain((await store.resolveAttachment(project.id, file.id)).path);
  const complete = finished(service, thread.id);
  runs[0].complete();
  await complete;
  const next = await service.sendMessage({
    projectId: project.id,
    threadId: thread.id,
    text: "Continue without new attachments",
  });
  expect(next.messages.filter((message) => message.role === "user")[1].attachments).toBeUndefined();
  expect(runs[1].input.images).toEqual([]);
  expect((await store.readThread(project.id, thread.id)).messages[0].attachments?.length).toBe(2);
});

test("missing attachments and empty turns cannot launch a harness", async () => {
  const { service, project, runs } = await fixture();
  await expect(
    service.startThread({ projectId: project.id, harness: "codex", prompt: "", designIds: [] }),
  ).rejects.toThrow("Write a message");
  await expect(
    service.startThread({
      projectId: project.id,
      harness: "codex",
      prompt: "Missing",
      designIds: [],
      attachmentIds: [randomUUID()],
    }),
  ).rejects.toThrow();
  expect(runs.length).toBe(0);
});

test("tool activity stays anchored, updates in place and persists independently of turn success", async () => {
  const { directory, service, store, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Fix tests",
    designIds: [],
  });
  const update = runs[0].input.onUpdate;
  update({ type: "session", id: randomUUID() });
  update({ type: "message", id: "comment", text: "Checking the implementation." });
  const tool = {
    id: "native-tool",
    kind: "test" as const,
    title: "bun test",
    toolName: "Shell",
    status: "running" as const,
    input: "bun test",
  };
  update({ type: "tool", tool });
  update({ type: "tool", tool: { ...tool, output: "Running" } });
  update({
    type: "tool",
    tool: { ...tool, status: "failed", output: "Running\n1 failed", exitCode: 1 },
  });
  update({ type: "message", id: "final", text: "Found the failing assertion." });
  const completion = finished(service, thread.id);
  runs[0].complete();
  const result = await completion;
  expect(result.status).toBe("completed");
  expect(result.error).toBeUndefined();
  expect(result.toolActivities).toHaveLength(1);
  const recorded = result.toolActivities![0];
  expect(recorded.afterMessageId).toBe(result.messages[1].id);
  expect(recorded).toMatchObject({ status: "failed", output: "Running\n1 failed", exitCode: 1 });
  expect(recorded.endedAt).toBeDefined();
  expect((await store.snapshot(project.id)).threads[0]).not.toHaveProperty("toolActivities");
  const reopened = new ProjectStore(join(directory, "app"));
  await reopened.initialize();
  expect((await reopened.readThread(project.id, thread.id)).toolActivities).toEqual(
    result.toolActivities,
  );
  await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "Try again" });
  runs[1].input.onUpdate({ type: "tool", tool });
  const resumed = await service.readThread(project.id, thread.id);
  expect(resumed.toolActivities).toHaveLength(2);
  expect(resumed.toolActivities![1].id).not.toBe(recorded.id);
  expect(resumed.toolActivities![1].afterMessageId).toBe(resumed.messages.at(-1)!.id);
});

test("stopped and unfinished tools never appear completed and late output is fenced", async () => {
  const { service, project, runs } = await fixture();
  for (const stop of [false, true]) {
    const thread = await service.startThread({
      projectId: project.id,
      harness: "claude",
      prompt: "Run a command",
      designIds: [],
    });
    const run = runs.at(-1)!;
    const tool = {
      id: "command",
      kind: "command" as const,
      title: "build",
      toolName: "Bash",
      status: "running" as const,
      output: "Building",
    };
    run.input.onUpdate({ type: "tool", tool });
    const completion = finished(service, thread.id);
    if (stop) await service.stopThread(project.id, thread.id);
    else run.complete();
    const result = await completion;
    expect(result.toolActivities![0].status).toBe(stop ? "cancelled" : "interrupted");
    expect(result.toolActivities![0].endedAt).toBeDefined();
    run.input.onUpdate({ type: "tool", tool: { ...tool, status: "completed", output: "Late" } });
    expect((await service.readThread(project.id, thread.id)).toolActivities![0].output).toBe(
      "Building",
    );
  }
});

test("long tool histories are bounded by count and text size with an explicit truncation marker", async () => {
  const { service, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Many tools",
    designIds: [],
  });
  const tool = {
    kind: "command" as const,
    title: "command",
    toolName: "Shell",
    status: "completed" as const,
  };
  for (let index = 0; index < MAX_TOOL_ACTIVITIES + 5; index++)
    runs[0].input.onUpdate({ type: "tool", tool: { ...tool, id: String(index) } });
  let result = await service.readThread(project.id, thread.id);
  expect(result.toolActivities).toHaveLength(MAX_TOOL_ACTIVITIES);
  expect(result.toolActivityTruncated).toBe(true);
  for (let index = 0; index < 40; index++)
    runs[0].input.onUpdate({
      type: "tool",
      tool: { ...tool, id: `large-${index}`, output: "x".repeat(32_000) },
    });
  result = await service.readThread(project.id, thread.id);
  expect(
    result.toolActivities!.reduce((sum, value) => sum + toolLogSize(value), 0),
  ).toBeLessThanOrEqual(MAX_TOOL_LOG_CHARACTERS);
  expect(result.toolActivities!.at(-1)!.output).toHaveLength(32_000);
});

test("permission replies are scoped to the live project, thread and request and cannot be replayed", async () => {
  const { service, store, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Work",
    designIds: [],
    settings: { permissionMode: "default" },
  });
  const id = randomUUID();
  runs[0].input.onUpdate({ type: "session", id: randomUUID() });
  runs[0].input.onUpdate({
    type: "approval",
    request: { id, title: "Allow command?", details: "bun test", choices: ["allow", "deny"] },
  });
  const active = await service.readThread(project.id, thread.id);
  expect(active.pendingApprovals?.[0].id).toBe(id);
  // Live requests are deliberately not durable authorizations.
  await store.writeThread(active);
  const live = service.withLiveThreads(project.id, (await store.snapshot(project.id)).threads);
  expect(live[0].pendingApprovalCount).toBe(1);
  expect(live[0]).not.toHaveProperty("pendingApprovals");
  expect(await store.readThread(project.id, thread.id)).not.toHaveProperty("pendingApprovals");
  await expect(service.respondToApproval(randomUUID(), thread.id, id, "allow")).rejects.toThrow(
    "another project",
  );
  await expect(
    service.respondToApproval(project.id, thread.id, randomUUID(), "allow"),
  ).rejects.toThrow("no longer");
  await expect(
    service.respondToApproval(project.id, thread.id, id, "allow-session"),
  ).rejects.toThrow("no longer");
  expect(runs[0].decisions).toHaveLength(0);
  const result = await service.respondToApproval(project.id, thread.id, id, "allow");
  expect(result.pendingApprovals).toEqual([]);
  expect(runs[0].decisions).toEqual([{ id, decision: "allow" }]);
  await expect(service.respondToApproval(project.id, thread.id, id, "allow")).rejects.toThrow(
    "no longer",
  );
  const completed = finished(service, thread.id);
  runs[0].complete();
  await completed;
  await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "Continue" });
  await expect(service.respondToApproval(project.id, thread.id, id, "allow")).rejects.toThrow(
    "no longer",
  );
  const nextId = randomUUID();
  runs[1].input.onUpdate({
    type: "approval",
    request: { id: nextId, title: "Allow command?", choices: ["allow", "deny"] },
  });
  await service.stopThread(project.id, thread.id);
  await expect(service.respondToApproval(project.id, thread.id, nextId, "allow")).rejects.toThrow(
    "no longer",
  );
  expect(runs[1].decisions).toHaveLength(0);
});

test("permission modes persist for follow-ups while live requests disappear on completion", async () => {
  const { service, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "Work",
    designIds: [],
    settings: { permissionMode: "auto" },
  });
  runs[0].input.onUpdate({ type: "session", id: randomUUID() });
  runs[0].input.onUpdate({
    type: "approval",
    request: { id: randomUUID(), title: "Native restriction", choices: ["allow", "deny"] },
  });
  const completed = finished(service, thread.id);
  runs[0].complete();
  expect((await completed).pendingApprovals).toBeUndefined();
  await service.setThreadSettings(project.id, thread.id, { permissionMode: "plan" });
  await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "Plan instead" });
  expect(runs[1].input.settings?.permissionMode).toBe("plan");
  await expect(
    service.setThreadSettings(project.id, thread.id, { permissionMode: "auto" }),
  ).rejects.toThrow("finish");
});

test("client IDs reconcile one durable message and cannot overwrite a thread or replay a message", async () => {
  const { service, store, project, runs } = await fixture();
  const threadId = randomUUID(),
    messageId = randomUUID();
  const thread = await service.startThread({
    projectId: project.id,
    threadId,
    messageId,
    harness: "codex",
    prompt: "Instant",
    designIds: [],
  });
  expect(thread.id).toBe(threadId);
  expect(thread.messages[0].id).toBe(messageId);
  runs[0].input.onUpdate({ type: "session", id: randomUUID() });
  const complete = finished(service, thread.id);
  runs[0].complete();
  await complete;
  await expect(
    service.startThread({
      projectId: project.id,
      threadId,
      harness: "claude",
      prompt: "Overwrite",
      designIds: [],
    }),
  ).rejects.toThrow("already exists");
  await expect(
    service.sendMessage({ projectId: project.id, threadId, messageId, text: "Replay" }),
  ).rejects.toThrow("already sent");
  expect((await store.readThread(project.id, threadId)).messages).toHaveLength(1);
  expect(runs).toHaveLength(1);
});

test("sending does not wait for catalog or account usage, and references skip image asset loading", async () => {
  const { store, project } = await fixture();
  const design = await store.createDesign(project.id);
  const readDesign = store.readDesign.bind(store),
    reads: Array<boolean | undefined> = [];
  store.readDesign = async (projectId, id, includeAssets) => {
    reads.push(includeAssets);
    return readDesign(projectId, id, includeAssets);
  };
  let configured = false,
    prompt = "";
  const service = new WorkspaceService(
    store,
    (input) => {
      prompt = input.prompt;
      return { done: Promise.resolve(), stop() {} };
    },
    async () => "/fixture/harness",
    async () => {
      configured = true;
      throw new Error("Usage service unavailable");
    },
  );
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Send without waiting for usage",
    settings: { model: "fixture-codex", effort: "high" },
    designIds: [design.id],
  });
  expect(configured).toBe(false);
  expect(prompt).toContain(design.path);
  expect(reads).toEqual([false]);
  expect(thread.messages[0].text).toBe("Send without waiting for usage");
  await service.close();
});

test("Stop cancels a turn still preparing, including a new optimistic thread", async () => {
  const { store, project } = await fixture();
  let release!: () => void,
    started!: () => void,
    launched = false;
  const preparing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new WorkspaceService(
    store,
    () => {
      launched = true;
      throw new Error("Must not launch");
    },
    async () => {
      started();
      await gate;
      return "/fixture/harness";
    },
  );
  const threadId = randomUUID();
  const request = service.startThread({
    projectId: project.id,
    threadId,
    messageId: randomUUID(),
    harness: "codex",
    prompt: "Cancel preparation",
    designIds: [],
  });
  await preparing;
  await expect(service.stopThread(randomUUID(), threadId)).rejects.toThrow("another project");
  await service.stopThread(project.id, threadId);
  release();
  expect((await request).status).toBe("stopped");
  expect(launched).toBe(false);
  expect((await store.readThread(project.id, threadId)).status).toBe("stopped");
  await service.close();
});

test("streaming transmits changed rows without replaying earlier conversation content", async () => {
  const { service, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Earlier task ".repeat(10) + "Private earlier request " + "x".repeat(20_000),
    designIds: [],
  });
  const patches: Array<Extract<DesktopEvent, { type: "thread-patch" }>> = [];
  const painted = new Promise<void>((resolve) =>
    service.subscribe((event) => {
      if (event.type === "thread-patch") {
        patches.push(event);
        resolve();
      }
    }),
  );
  runs[0].input.onUpdate({ type: "message", id: "assistant", text: "Streaming response" });
  await painted;
  expect(patches[0].messages.map((message) => message.text)).toEqual(["Streaming response"]);
  expect(JSON.stringify(patches[0])).not.toContain("Private earlier request");
  expect(JSON.stringify(patches[0]).length).toBeLessThan(2_000);
  expect((await service.readThread(project.id, thread.id)).messages[0].text).toContain(
    "Private earlier request",
  );
});

test("skill selection resolves in the main process, preserves the transcript and rejects foreign IDs before launch", async () => {
  const adapter: SkillAdapter = {
    async discover() {
      return [{ kind: "command", name: "review", description: "Review changes" }];
    },
  };
  const skills = new HarnessSkills(async () => "/fixture", { codex: adapter, claude: adapter });
  const { service, store, project, runs } = await fixture(undefined, false, skills);
  const catalog = await skills.list({ harness: "claude", cwd: project.path });
  const input = {
    projectId: project.id,
    harness: "claude" as const,
    prompt: "/review current changes",
    designIds: [],
    skillId: catalog.skills[0].id,
  };
  await expect(service.startThread({ ...input, skillId: "/etc/passwd" })).rejects.toThrow(
    "no longer available",
  );
  expect(runs).toHaveLength(0);
  expect((await store.snapshot(project.id)).threads).toHaveLength(0);
  const thread = await service.startThread(input);
  expect(thread.messages[0].text).toBe(input.prompt);
  expect(runs[0].input.skill).toMatchObject({
    invocation: { kind: "command", name: "review" },
    prompt: input.prompt,
  });
  expect(runs[0].input.skill?.context).toContain("local Tidy project");
  expect(thread.settings?.permissionMode).not.toBe("auto");
  const done = finished(service, thread.id);
  runs[0].complete();
  await done;
  await service.sendMessage({
    projectId: project.id,
    threadId: thread.id,
    text: "/review again",
    skillId: input.skillId,
  });
  expect(runs[1].input.skill?.prompt).toBe("/review again");
});

test("workspace threads keep shared designs and attachments separate from each local execution project", async () => {
  const { directory, store, service, project, runs } = await fixture();
  const cloudRoot = join(directory, "cloud-workspace");
  const secondRoot = join(directory, "second-repository");
  await mkdir(cloudRoot);
  await mkdir(secondRoot);
  const workspace = (await store.open(cloudRoot, "Team")).project;
  const second = (await store.open(secondRoot)).project;
  service.authorizeCloudProject = async (id) => {
    expect(id).toBe(workspace.id);
  };
  const design = await store.createDesign(workspace.id);
  const attachment = await store.addAttachment(
    workspace.id,
    "notes.txt",
    "data:text/plain;base64,aGVsbG8=",
  );
  const first = await service.startThread({
    projectId: workspace.id,
    executionProjectId: project.id,
    harness: "codex",
    prompt: "Implement the shared design",
    designIds: [design.id],
    attachmentIds: [attachment.id],
  });
  const other = await service.startThread({
    projectId: workspace.id,
    executionProjectId: second.id,
    harness: "claude",
    prompt: "Implement it for another app",
    designIds: [design.id],
  });
  const designOnly = await service.startThread({
    projectId: workspace.id,
    harness: "codex",
    prompt: "Refine the design",
    designIds: [design.id],
  });
  expect(runs.map((run) => run.input.cwd)).toEqual([project.path, second.path, workspace.path]);
  expect(runs[0].input.prompt).toContain(design.path);
  expect(runs[0].input.prompt).toContain("notes.txt");
  expect(runs[0].input.additionalDirectories).toEqual([
    await store.storagePath(workspace.id, "designs"),
    await store.storagePath(workspace.id, "assets"),
  ]);
  expect(runs[2].input.additionalDirectories).toEqual([]);
  expect(await store.designs(project.id)).toHaveLength(0);
  expect((await store.snapshot(workspace.id)).threads.map((thread) => thread.id).sort()).toEqual(
    [first.id, other.id, designOnly.id].sort(),
  );
  const sessionId = randomUUID();
  runs[0].input.onUpdate({ type: "session", id: sessionId });
  const complete = finished(service, first.id);
  runs[0].complete();
  await complete;
  // Changing the app's selected repository cannot redirect a resumed thread.
  await store.select(second.id);
  await service.sendMessage({ projectId: workspace.id, threadId: first.id, text: "Continue" });
  expect(runs[3].input.cwd).toBe(project.path);
  expect(runs[3].input.sessionId).toBe(sessionId);
  expect((await store.readThread(workspace.id, first.id)).executionProjectId).toBe(project.id);
});

test("local threads cannot acquire another execution project and cloud targets must be local", async () => {
  const { directory, store, service, project, runs } = await fixture();
  await mkdir(join(directory, "cloud"));
  const cloud = (await store.open(join(directory, "cloud"), "Team")).project;
  service.authorizeCloudProject = async () => {};
  await expect(
    service.startThread({
      projectId: project.id,
      executionProjectId: cloud.id,
      harness: "codex",
      prompt: "Invalid",
      designIds: [],
    }),
  ).rejects.toThrow("Choose a local project");
  await expect(
    service.startThread({
      projectId: cloud.id,
      executionProjectId: cloud.id,
      harness: "codex",
      prompt: "Invalid",
      designIds: [],
    }),
  ).rejects.toThrow("Choose a local project");
  expect(runs).toHaveLength(0);
});

test("revoked cloud access during preparation prevents native launch", async () => {
  const { directory, store, service, project, runs, preparation, resumePreparation } =
    await fixture(undefined, true);
  await mkdir(join(directory, "cloud"));
  const cloud = (await store.open(join(directory, "cloud"), "Team")).project;
  let allowed = true;
  service.authorizeCloudProject = async () => {
    if (!allowed) throw new Error("Account changed");
  };
  const starting = service.startThread({
    projectId: cloud.id,
    executionProjectId: project.id,
    harness: "codex",
    prompt: "Start",
    designIds: [],
  });
  await preparation;
  allowed = false;
  resumePreparation();
  await expect(starting).rejects.toThrow("Account changed");
  expect(runs).toHaveLength(0);
});

test("Stop during the final execution authority check never launches a process or leaves a running thread", async () => {
  const f = await fixture();
  const id = randomUUID();
  const entered = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>();
  const original = f.store.assertThreadExecution.bind(f.store);
  let calls = 0;
  const validation = spyOn(f.store, "assertThreadExecution").mockImplementation(async (...args) => {
    await original(...args);
    if (++calls === 2) {
      entered.resolve();
      await gate.promise;
    }
  });
  try {
    const starting = f.service.startThread({
      projectId: f.project.id,
      threadId: id,
      harness: "codex",
      prompt: "Start",
      designIds: [],
    });
    await entered.promise;
    await f.service.stopThread(f.project.id, id);
    gate.resolve();
    expect((await starting).status).toBe("stopped");
    expect(f.runs).toHaveLength(0);
    expect((await f.store.readThread(f.project.id, id)).status).toBe("stopped");
  } finally {
    gate.resolve();
    validation.mockRestore();
  }
});
