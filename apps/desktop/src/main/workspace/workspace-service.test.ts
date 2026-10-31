import { videoChunkSchema } from "../../shared/contracts/video-preview";
import { HarnessSkills, type SkillAdapter } from "../harnesses/harness-skills";
import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as filesystem from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";
import { createWorkspaceRequests } from "../ipc/workspace-requests";
import * as harnessDiscovery from "../harnesses/harnesses";
import type { startHarness, HarnessUpdate } from "../harnesses/harnesses";
import type { DesktopEvent, Thread } from "../../shared/contracts/desktop";
import type { DesignAgentResult } from "../../shared/contracts/design-agent";
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
  namer?: ConstructorParameters<typeof WorkspaceService>[5],
  locate?: ConstructorParameters<typeof WorkspaceService>[2],
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
      const stopping = Promise.withResolvers<void>();
      const run: (typeof runs)[number] = {
        input,
        stopping: stopping.promise,
        complete,
        stopped: false,
        decisions: [],
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
          stopping.resolve();
          if (!holdStop) complete();
        },
      };
    },
    async (...args) => {
      if (locate) return locate(...args);
      prepared();
      if (holdPreparation) await preparationGate;
      return "/fixture/harness";
    },
    configure,
    skills,
    namer,
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

async function designClient(prompt: string) {
  const config = prompt.match(/--config '([^']+)'/)?.[1];
  if (!config) throw new Error("Missing local agent configuration");
  const text = await readFile(config, "utf8");
  const url = text.match(/^url = "([^"]+)"/m)![1];
  const token = text.match(/Bearer ([a-f0-9]{64})/)![1];
  return async (action: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(action),
    });
    return { status: response.status, body: (await response.json()) as DesignAgentResult };
  };
}

test("local design actions create one editable file, reveal it in the thread, and preserve its identity on retries", async () => {
  const f = await fixture();
  const thread = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "Explore a sidebar",
    designIds: [],
  });
  const request = await designClient(f.runs[0].input.prompt);
  expect(f.runs[0].input.prompt).toContain("do not create a separate HTML preview");
  const action = { kind: "design-create", requestId: randomUUID(), name: "Sidebar CTA" };
  const [first, retry] = await Promise.all([request(action), request(action)]);
  expect(first.status).toBe(200);
  expect(first.body.design.id).toBe(retry.body.design.id);
  expect(first.body.sync.status).toBe("local");
  expect(first.body.design.path).toContain("/.tidy/designs/");
  expect(first.body.design.name).toBe("Sidebar CTA");
  expect((await f.store.designs(f.project.id)).length).toBe(1);
  const live = await f.service.readThread(f.project.id, thread.id);
  expect(live.designIds).toEqual([first.body.design.id]);
  expect(live.designPreview?.designId).toBe(first.body.design.id);
  expect("designPreview" in (await f.store.readThread(f.project.id, thread.id))).toBe(false);
  const reopened = await request({ kind: "design-open", designId: first.body.design.id });
  expect(reopened.body.previewAttached).toBe(true);
  expect((await f.service.readThread(f.project.id, thread.id)).designPreview?.id).not.toBe(
    live.designPreview?.id,
  );
  const state = await request({ kind: "design-state", designId: first.body.design.id });
  expect(state.body.design).toEqual(first.body.design);
  expect((await request({ ...action, name: "Another name" })).status).toBe(400);
});

test("local design capabilities reject foreign designs and expire when the turn ends", async () => {
  const f = await fixture();
  const otherRoot = join(f.directory, "other-project");
  await mkdir(otherRoot);
  const other = await f.store.open(otherRoot);
  const foreign = await f.store.createDesign(other.project.id);
  const thread = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "Design",
    designIds: [],
  });
  const request = await designClient(f.runs[0].input.prompt);
  expect(
    (
      await request(
        { kind: "design-create", requestId: randomUUID(), name: "Cross origin" },
        { Origin: "https://example.com" },
      )
    ).status,
  ).toBe(403);
  expect((await request({ kind: "design-open", designId: foreign.id })).status).toBe(400);
  expect((await f.service.readThread(f.project.id, thread.id)).designIds).toEqual([]);
  const done = finished(f.service, thread.id);
  f.runs[0].complete();
  await done;
  expect(
    (await request({ kind: "design-create", requestId: randomUUID(), name: "Too late" })).status,
  ).toBe(403);
  expect(await f.store.designs(f.project.id)).toEqual([]);
});

test("a failed thread checkpoint retains the created design for an idempotent retry", async () => {
  const f = await fixture();
  const thread = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "Explore",
    designIds: [],
  });
  const request = await designClient(f.runs[0].input.prompt);
  const action = { kind: "design-create", requestId: randomUUID(), name: "Exploration" };
  const write = f.store.writeThread.bind(f.store);
  const failed = spyOn(f.store, "writeThread").mockImplementationOnce(async () => {
    throw new Error("Checkpoint failed");
  });
  try {
    expect((await request(action)).status).toBe(400);
    const live = await f.service.readThread(f.project.id, thread.id);
    expect(live.designIds).toEqual([]);
    expect(live.designPreview).toBeUndefined();
    failed.mockImplementation(write);
    const retry = await request(action);
    expect(retry.status).toBe(200);
    expect((await f.store.designs(f.project.id)).map((d) => d.id)).toEqual([retry.body.design.id]);
  } finally {
    failed.mockRestore();
  }
});

test("a failed design creation can be retried with the same request ID", async () => {
  const f = await fixture();
  await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "Explore",
    designIds: [],
  });
  const request = await designClient(f.runs[0].input.prompt);
  const action = { kind: "design-create", requestId: randomUUID(), name: "Exploration" };
  const create = f.store.createDesign.bind(f.store);
  const failing = spyOn(f.store, "createDesign").mockRejectedValueOnce(
    new Error("Disk unavailable"),
  );
  try {
    expect((await request(action)).status).toBe(400);
    expect(await f.store.designs(f.project.id)).toEqual([]);
    failing.mockImplementation(create);
    const retry = await request(action);
    expect(retry.status).toBe(200);
    expect((await request(action)).body.design.id).toBe(retry.body.design.id);
    expect((await f.store.designs(f.project.id)).map((d) => d.id)).toEqual([retry.body.design.id]);
  } finally {
    failing.mockRestore();
  }
});

test.each([
  ["codex", "read-only"],
  ["claude", "plan"],
] as const)("%s local design actions respect %s mode", async (harness, permissionMode) => {
  const f = await fixture();
  const existing = await f.store.createDesign(f.project.id);
  await f.service.startThread({
    projectId: f.project.id,
    harness,
    prompt: "Review the design",
    designIds: [],
    settings: { permissionMode },
  });
  const request = await designClient(f.runs[0].input.prompt);
  expect(
    (await request({ kind: "design-create", requestId: randomUUID(), name: "Not allowed" })).status,
  ).toBe(400);
  expect((await request({ kind: "design-open", designId: existing.id })).status).toBe(200);
  expect((await f.store.designs(f.project.id)).map((d) => d.id)).toEqual([existing.id]);
});

test("stopping during a design read prevents a late preview or sync request", async () => {
  const f = await fixture();
  const existing = await f.store.createDesign(f.project.id);
  const thread = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "Design",
    designIds: [],
  });
  const request = await designClient(f.runs[0].input.prompt);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = f.store.readDesignReference.bind(f.store);
  const delayed = spyOn(f.store, "readDesignReference").mockImplementation(async (...args) => {
    started.resolve();
    await release.promise;
    return read(...args);
  });
  try {
    const opening = request({ kind: "design-open", designId: existing.id });
    await started.promise;
    await f.service.stopThread(f.project.id, thread.id);
    release.resolve();
    expect((await opening).status).toBe(400);
    expect((await f.service.readThread(f.project.id, thread.id)).designIds).toEqual([]);
  } finally {
    release.resolve();
    delayed.mockRestore();
  }
});

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

test("queued follow-ups wait for maintenance and start automatically after installation", async () => {
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
  expect(queued.queueError).toBeUndefined();
  expect(queued.queuedMessages?.map((message) => message.id)).toEqual([messageId]);
  expect((await store.readThread(project.id, thread.id)).queuedMessages?.[0].text).toBe(
    "Next response",
  );
  expect(runs).toHaveLength(1);
  const launched = Promise.withResolvers<Thread>();
  const unsubscribe = service.subscribe((event) => {
    if (
      event.type === "thread" &&
      event.thread.id === thread.id &&
      event.thread.status === "running"
    )
      launched.resolve(event.thread);
  });
  release!();
  const sent = await launched.promise;
  unsubscribe();
  expect(sent.status).toBe("running");
  expect(sent.queuedMessages).toHaveLength(0);
  // The running checkpoint is emitted immediately before native launch.
  await service.dispatch(async () => {});
  for (let attempt = 0; attempt < 100 && runs.length < 2; attempt++) await Bun.sleep(5);
  expect(runs).toHaveLength(2);
});

for (const stop of [false, true]) {
  test(`a Claude turn finishing during a native update ${stop ? "respects Stop on its deferred queue" : "continues its queue after installation"}`, async () => {
    const { service, project, runs } = await fixture();
    const thread = await service.startThread({
      projectId: project.id,
      harness: "claude",
      prompt: "First response",
      designIds: [],
    });
    await service.sendMessage({
      projectId: project.id,
      threadId: thread.id,
      text: "Next response",
      delivery: "queue",
    });
    const release = service.reserveHarnessUpdate("claude", { allowActiveRuns: true });
    expect(release).not.toBeNull();
    const complete = finished(service, thread.id);
    runs[0].complete();
    await complete;
    // Serialize a read of the queue behind completion and deferred delivery.
    await service.updateMessageQueue({
      projectId: project.id,
      threadId: thread.id,
      action: {
        kind: "edit",
        messageId: (await service.readThread(project.id, thread.id)).queuedMessages![0].id,
        text: "Edited next response",
      },
    });
    expect(runs).toHaveLength(1);
    if (stop) await service.stopThread(project.id, thread.id);
    release!();
    if (stop) {
      await Bun.sleep(15);
      expect(runs).toHaveLength(1);
    } else {
      for (let attempt = 0; attempt < 100 && runs.length < 2; attempt++) await Bun.sleep(5);
      expect(runs).toHaveLength(2);
      expect(runs[1].input.prompt).toContain("Edited next response");
    }
  });
}

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

test.each([new Error("Disk full"), undefined, false])(
  "Done does not stop another project's run or publish Done after a failed checkpoint (%s)",
  async (failure) => {
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
    await expect(service.setThreadDone(other.id, thread.id, true)).rejects.toThrow(
      "another project",
    );
    expect(runs[0].stopped).toBe(false);
    const write = store.writeThread.bind(store);
    store.writeThread = async () => {
      throw failure;
    };
    const events: Thread[] = [];
    const unsubscribe = service.subscribe((event) => {
      if (event.type === "thread") events.push(structuredClone(event.thread));
    });
    try {
      await expect(service.setThreadDone(project.id, thread.id, true)).rejects.toBe(failure);
      expect(runs[0].stopped).toBe(true);
      expect(events.every((value) => value.doneAt === undefined)).toBe(true);
      expect((await store.readThread(project.id, thread.id)).doneAt).toBeUndefined();
    } finally {
      store.writeThread = write;
      unsubscribe();
    }
  },
);

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
  await service.setThreadSettings(project.id, thread.id, { model: "third-model" });
  expect(runs[1].input.settings?.model).toBe("another-model");
  expect((await service.readThread(project.id, thread.id)).settings?.model).toBe("third-model");
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

test("running settings survive streamed updates and apply to queued follow-ups", async () => {
  const { service, store, project, runs } = await fixture();
  const original = { model: "first-model", effort: "medium", permissionMode: "auto" as const };
  const next = { model: "next-model", effort: "high", permissionMode: "read-only" as const };
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "First",
    designIds: [],
    settings: original,
  });
  await service.sendMessage({
    projectId: project.id,
    threadId: thread.id,
    text: "Queued follow-up",
    delivery: "queue",
  });
  await service.setThreadSettings(project.id, thread.id, next);
  runs[0].input.onUpdate({ type: "session", id: randomUUID() });
  expect((await service.readThread(project.id, thread.id)).settings).toEqual(next);
  expect((await store.readThread(project.id, thread.id)).settings).toEqual(next);
  expect(runs[0].input.settings).toEqual(original);
  expect(runs[0].stopped).toBe(false);
  const completion = finished(service, thread.id);
  runs[0].complete();
  await completion;
  for (let attempt = 0; attempt < 100 && runs.length < 2; attempt++) await Bun.sleep(5);
  expect(runs).toHaveLength(2);
  expect(runs[1].input.settings).toEqual(next);
  expect((await service.readThread(project.id, thread.id)).queuedMessages).toHaveLength(0);
});

test("running settings reject foreign projects and roll back failed validation or persistence", async () => {
  let invalid = false;
  const { service, store, project, runs, directory } = await fixture(async () => {
    if (invalid) throw new Error("Invalid settings");
  });
  const original = { model: "first-model" };
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "First",
    designIds: [],
    settings: original,
  });
  const root = join(directory, "other");
  await mkdir(root);
  const other = (await store.open(root)).project;
  await expect(
    service.setThreadSettings(other.id, thread.id, { model: "next-model" }),
  ).rejects.toThrow("another project");
  invalid = true;
  await expect(
    service.setThreadSettings(project.id, thread.id, { model: "next-model" }),
  ).rejects.toThrow("Invalid settings");
  invalid = false;
  const write = store.writeThread.bind(store);
  store.writeThread = async () => {
    throw new Error("Disk full");
  };
  try {
    await expect(
      service.setThreadSettings(project.id, thread.id, { model: "next-model" }),
    ).rejects.toThrow("Disk full");
  } finally {
    store.writeThread = write;
  }
  expect((await service.readThread(project.id, thread.id)).settings).toEqual(original);
  expect((await store.readThread(project.id, thread.id)).settings).toEqual(original);
  expect(runs[0].stopped).toBe(false);
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
  expect(thread.title).toBe("New thread");
  expect(thread.messages[0].attachments?.map((file) => file.name)).toEqual([
    "Screenshot.png",
    "Notes.txt",
  ]);
  expect(JSON.stringify(thread)).not.toContain(png);
  expect(runs[0].input.images?.[0]).toMatchObject({
    path: (await store.resolveAttachment(project.id, image.id)).path,
    mimeType: "image/png",
    data: "",
  });
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

test("turn timing survives storage, status follows events and resumed turns get their own clock", async () => {
  const { service, store, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Check the sidebar",
    designIds: [],
  });
  const startedAt = thread.messages[0].turn?.startedAt;
  expect(startedAt).toBeDefined();
  expect(thread.messages[0].sentAt).toBe(startedAt);
  if (!startedAt) throw new Error("The turn did not record its start time.");
  expect(thread.activity).toBe("Starting");
  const update = runs[0].input.onUpdate;
  update({ type: "activity", activity: "Thinking" });
  expect((await service.readThread(project.id, thread.id)).activity).toBe("Thinking");
  update({ type: "message", id: "reply", text: "Checking " });
  update({ type: "message", id: "reply", text: "the sidebar.", append: true });
  expect((await service.readThread(project.id, thread.id)).activity).toBe("Replying");
  const completion = finished(service, thread.id);
  runs[0].complete();
  const result = await completion;
  expect(result.messages[0].turn).toEqual({ startedAt, endedAt: expect.any(String) });
  expect(result.messages[1].text).toBe("Checking the sidebar.");
  expect((await store.readThread(project.id, thread.id)).messages[0].turn).toEqual(
    result.messages[0].turn,
  );
  expect((await store.readThread(project.id, thread.id)).messages[0].sentAt).toBe(startedAt);
  await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "Continue" });
  const resumed = await service.readThread(project.id, thread.id);
  expect(resumed.messages[0].turn).toEqual(result.messages[0].turn);
  expect(resumed.messages.at(-1)?.turn).toEqual({ startedAt: expect.any(String) });
  const stopped = finished(service, thread.id);
  await service.stopThread(project.id, thread.id);
  expect((await stopped).messages.at(-1)?.turn?.endedAt).toBeDefined();
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
  await service.setThreadSettings(project.id, thread.id, { permissionMode: "auto" });
  expect(runs[1].input.settings?.permissionMode).toBe("plan");
  expect((await service.readThread(project.id, thread.id)).settings?.permissionMode).toBe("auto");
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

test("sending does not wait for catalog or account usage, and references use validated metadata without loading scenes", async () => {
  const { store, project } = await fixture();
  const design = await store.createDesign(project.id);
  const readDesign = spyOn(store, "readDesign");
  const references = spyOn(store, "readDesignReference");
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
  expect(references).toHaveBeenCalledWith(project.id, design.id);
  expect(readDesign).not.toHaveBeenCalled();
  readDesign.mockRestore();
  references.mockRestore();
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
  const skills = new HarnessSkills(async () => "/fixture", {
    codex: adapter,
    claude: adapter,
    opencode: adapter,
  });
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

test("idle workspace threads can change execution projects without losing their conversation or reusing native sessions", async () => {
  const { directory, store, service, project, runs } = await fixture();
  const cloudRoot = join(directory, "cloud");
  const secondRoot = join(directory, "second");
  await mkdir(cloudRoot);
  await mkdir(secondRoot);
  const cloud = (await store.open(cloudRoot, "Team")).project;
  const second = (await store.open(secondRoot)).project;
  service.authorizeCloudProject = async () => {};
  const design = await store.createDesign(cloud.id);
  const attachment = await store.addAttachment(
    cloud.id,
    "notes.txt",
    "data:text/plain;base64,aGVsbG8=",
  );
  const thread = await service.startThread({
    projectId: cloud.id,
    harness: "codex",
    prompt: "Refine the design first",
    designIds: [design.id],
    attachmentIds: [attachment.id],
    settings: { permissionMode: "read-only" },
  });
  const sessionId = randomUUID();
  runs[0].input.onUpdate({ type: "session", id: sessionId });
  let done = finished(service, thread.id);
  runs[0].complete();
  const original = await done;
  expect(original.sessionId).toBe(sessionId);
  // Ordinary checkpoints must never grant a different directory, even after this feature is added.
  await expect(store.writeThread({ ...original, executionProjectId: project.id })).rejects.toThrow(
    "execution project changed",
  );
  const changed = await service.setThreadExecutionProject(cloud.id, thread.id, project.id);
  expect(changed.id).toBe(thread.id);
  expect(changed.messages).toEqual(original.messages);
  expect(changed.designIds).toEqual([design.id]);
  expect(changed.settings).toEqual(original.settings);
  expect(changed.sessionId).toBeUndefined();
  expect(changed.revision).toBe(original.revision + 1);
  const restarted = new ProjectStore(join(directory, "app"));
  await restarted.initialize();
  expect((await restarted.readThread(cloud.id, thread.id)).executionProjectId).toBe(project.id);
  expect((await restarted.readThread(cloud.id, thread.id)).sessionId).toBeUndefined();
  await service.sendMessage({ projectId: cloud.id, threadId: thread.id, text: "Now implement it" });
  expect(runs[1].input.cwd).toBe(project.path);
  expect(runs[1].input.sessionId).toBeUndefined();
  expect(runs[1].input.prompt).toContain("Refine the design first");
  expect(runs[1].input.prompt).toContain(design.path);
  expect(runs[1].input.prompt).toContain("Now implement it");
  done = finished(service, thread.id);
  const newSessionId = randomUUID();
  runs[1].input.onUpdate({ type: "session", id: newSessionId });
  runs[1].complete();
  await done;
  // Selecting the same project preserves its session; changing it retires that session.
  expect((await service.setThreadExecutionProject(cloud.id, thread.id, project.id)).sessionId).toBe(
    newSessionId,
  );
  expect(
    (await service.setThreadExecutionProject(cloud.id, thread.id, second.id)).executionProjectId,
  ).toBe(second.id);
  const designOnly = await service.setThreadExecutionProject(cloud.id, thread.id);
  expect(designOnly.executionProjectId).toBeUndefined();
  expect(designOnly.sessionId).toBeUndefined();
  await service.sendMessage({ projectId: cloud.id, threadId: thread.id, text: "Back to design" });
  expect(runs[2].input.cwd).toBe(cloud.path);
  expect(runs[2].input.additionalDirectories).toEqual([]);
  expect((await store.readThread(cloud.id, thread.id)).messages[0].attachments?.[0].id).toBe(
    attachment.id,
  );
});

test("execution changes reject active runs, local owners, invalid targets, revoked access and edited bindings", async () => {
  const { directory, store, service, project, runs } = await fixture();
  await mkdir(join(directory, "cloud"));
  const cloud = (await store.open(join(directory, "cloud"), "Team")).project;
  service.authorizeCloudProject = async () => {};
  const thread = await service.startThread({
    projectId: cloud.id,
    harness: "codex",
    prompt: "Design",
    designIds: [],
  });
  await expect(service.setThreadExecutionProject(cloud.id, thread.id, project.id)).rejects.toThrow(
    "run to finish",
  );
  const done = finished(service, thread.id);
  runs[0].complete();
  await done;
  await expect(service.setThreadExecutionProject(cloud.id, thread.id, cloud.id)).rejects.toThrow(
    "local project",
  );
  await expect(
    service.setThreadExecutionProject(cloud.id, thread.id, randomUUID()),
  ).rejects.toThrow();
  const local = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Local",
    designIds: [],
  });
  const localDone = finished(service, local.id);
  runs[1].complete();
  await localDone;
  await expect(service.setThreadExecutionProject(project.id, local.id)).rejects.toThrow(
    "Only workspace threads",
  );
  service.authorizeCloudProject = async () => {
    throw new Error("Access revoked");
  };
  await expect(service.setThreadExecutionProject(cloud.id, thread.id, project.id)).rejects.toThrow(
    "Access revoked",
  );
  expect((await store.readThread(cloud.id, thread.id)).executionProjectId).toBeUndefined();
  service.authorizeCloudProject = async () => {};
  const current = await store.readThread(cloud.id, thread.id);
  await writeFile(
    await store.storagePath(cloud.id, "threads", thread.id),
    JSON.stringify({ ...current, executionProjectId: project.id }),
  );
  await expect(service.setThreadExecutionProject(cloud.id, thread.id)).rejects.toThrow(
    "execution project changed",
  );
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

test("active run count deduplicates launch preparation and excludes metadata edits", async () => {
  const f = await fixture(async () => {}, true);
  const run = f.service.startThread({
    projectId: f.project.id,
    harness: "claude",
    prompt: "Count this run",
    designIds: [],
  });
  expect(f.service.activeRunCount).toBe(1);
  await f.preparation;
  expect(f.service.activeRunCount).toBe(1);
  const write = f.store.writeThread.bind(f.store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let pause = true;
  f.store.writeThread = async (thread) => {
    if (pause && thread.status === "running") {
      entered.resolve();
      await release.promise;
    }
    return write(thread);
  };
  f.resumePreparation();
  await entered.promise;
  expect(f.service.activeRunCount).toBe(1);
  pause = false;
  release.resolve();
  const thread = await run;
  const done = finished(f.service, thread.id);
  f.runs[0].complete();
  await done;
  expect(f.service.activeRunCount).toBe(0);
  const metadataEntered = Promise.withResolvers<void>();
  const metadataRelease = Promise.withResolvers<void>();
  f.store.writeThread = async (value) => {
    metadataEntered.resolve();
    await metadataRelease.promise;
    return write(value);
  };
  const edit = f.service.setThreadDone(f.project.id, thread.id, true);
  await metadataEntered.promise;
  expect(f.service.activeRunCount).toBe(0);
  metadataRelease.resolve();
  await edit;
});

test("update preparation drains accepted desktop requests before flushing and allows recovery", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const create = f.store.createFolder.bind(f.store);
  f.store.createFolder = async (...args) => {
    entered.resolve();
    await gate.promise;
    return create(...args);
  };
  const requests = createWorkspaceRequests(f.service, {
    chooseProject: async () => null,
    chooseDesign: async () => null,
    openExternal: async () => {},
    showItemInFolder() {},
  });
  const request = requests.invoke(
    "create-design-folder",
    { projectId: f.project.id, name: "Accepted" },
    undefined,
  );
  await entered.promise;
  let ready = false;
  const preparation = f.service.prepareUpdate().then((resume) => {
    ready = true;
    return resume;
  });
  await expect(
    requests.invoke(
      "create-design-folder",
      { projectId: f.project.id, name: "Rejected" },
      undefined,
    ),
  ).rejects.toThrow("closing");
  expect(ready).toBe(false);
  gate.resolve();
  await request;
  const resume = await preparation;
  expect(ready).toBe(true);
  expect((await f.store.folders(f.project.id)).map((folder) => folder.name)).toEqual(["Accepted"]);
  resume();
  await requests.invoke(
    "create-design-folder",
    { projectId: f.project.id, name: "Resumed" },
    undefined,
  );
  expect(await f.store.folders(f.project.id)).toHaveLength(2);
});

test("project removal refuses preparing and running work", async () => {
  const f = await fixture(undefined, true);
  const pending = f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "Work",
    designIds: [],
  });
  await f.preparation;
  await expect(f.service.removeProject(f.project.id)).rejects.toThrow("active work");
  f.resumePreparation();
  const thread = await pending;
  await expect(f.service.removeProject(f.project.id)).rejects.toThrow("active work");
  const complete = finished(f.service, thread.id);
  f.runs[0].complete();
  await complete;
  await f.service.removeProject(f.project.id);
  expect(f.store.projects).toHaveLength(0);
  await expect(
    f.service.startThread({
      projectId: f.project.id,
      harness: "codex",
      prompt: "Late",
      designIds: [],
    }),
  ).rejects.toThrow("Open this project");
});

test("remove-project validates its input and acknowledges removal after access is revoked", async () => {
  const f = await fixture();
  const requests = createWorkspaceRequests(f.service, {
    chooseProject: async () => null,
    chooseDesign: async () => null,
    openExternal: async () => {},
    showItemInFolder() {},
  });
  await expect(requests.invoke("remove-project", "../project", undefined)).rejects.toThrow(
    "Invalid desktop request",
  );
  await requests.invoke("remove-project", f.project.id, undefined);
  expect(f.service.canAccessProject(f.project.id)).toBe(false);
  expect(f.store.activeProjectId).toBeNull();
});

test("an observation paused before removal cannot watch a reopened registration", async () => {
  const f = await fixture();
  const pathsReady = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const storagePath = f.store.storagePath.bind(f.store);
  let resolved = 0;
  const paths = spyOn(f.store, "storagePath").mockImplementation(async (...args) => {
    const path = await storagePath(...args);
    if (++resolved === 2) pathsReady.resolve();
    await resume.promise;
    return path;
  });
  const watches = spyOn(filesystem, "watch");
  const observing = f.service.observe(f.project.id);
  try {
    await pathsReady.promise;
    paths.mockRestore();
    await f.service.removeProject(f.project.id);
    const reopened = await f.store.open(f.project.path);
    expect(reopened.project.id).toBe(f.project.id);
    resume.resolve();
    await observing;
    expect(watches).not.toHaveBeenCalled();
    await Promise.all([f.service.observe(f.project.id), f.service.observe(f.project.id)]);
    expect(watches).toHaveBeenCalledTimes(2);
  } finally {
    paths.mockRestore();
    watches.mockRestore();
    resume.resolve();
    await observing;
  }
});

test("failure categories survive storage and summaries, then clear on a new turn", async () => {
  const { service, project, runs, store } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "First",
    designIds: [],
  });
  runs[0].input.onUpdate({ type: "error", text: "A generic provider failure", kind: "sandbox" });
  const completion = finished(service, thread.id);
  runs[0].complete();
  const result = await completion;
  expect(result).toMatchObject({ status: "failed", errorKind: "sandbox" });
  expect((await store.readThread(project.id, thread.id)).errorKind).toBe("sandbox");
  expect(
    (await store.select(project.id)).threads.find((value) => value.id === thread.id)?.errorKind,
  ).toBe("sandbox");
  const next = await service.sendMessage({
    projectId: project.id,
    threadId: thread.id,
    text: "Continue",
  });
  expect(next.error).toBeUndefined();
  expect(next.errorKind).toBeUndefined();
});

test("a recovered provider error does not erase an unrelated local storage failure", async () => {
  const { service, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "First",
    designIds: [],
  });
  runs[0].input.onUpdate({ type: "error", text: "Provider overloaded", kind: "unavailable" });
  runs[0].input.onUpdate({ type: "error", text: "Disk is full", kind: "storage" });
  runs[0].input.onUpdate({ type: "error-cleared", text: "Provider overloaded" });
  const completion = finished(service, thread.id);
  runs[0].complete();
  expect(await completion).toMatchObject({
    status: "failed",
    errorKind: "storage",
    error: "Disk is full",
  });
});

test("a provider retry that recovers leaves no failed status or stale error category", async () => {
  const { service, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "claude",
    prompt: "First",
    designIds: [],
  });
  runs[0].input.onUpdate({ type: "error", text: "Provider overloaded", kind: "unavailable" });
  runs[0].input.onUpdate({ type: "error-cleared", text: "Provider overloaded" });
  const completion = finished(service, thread.id);
  runs[0].complete();
  expect(await completion).toMatchObject({
    status: "completed",
    errorKind: undefined,
    error: undefined,
  });
});

test("a failed final disk write marks the thread failed with storage guidance", async () => {
  const { service, project, runs, store } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "First",
    designIds: [],
  });
  const writer = spyOn(store, "writeThread").mockRejectedValueOnce(new Error("ENOSPC"));
  try {
    const completion = finished(service, thread.id);
    runs[0].complete();
    expect(await completion).toMatchObject({ status: "failed", errorKind: "storage" });
  } finally {
    writer.mockRestore();
  }
});

test("bootstrap returns the project while harness discovery is still pending", async () => {
  const { service, project } = await fixture();
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof harnessDiscovery.checkHarnesses>>>();
  const probe = spyOn(harnessDiscovery, "checkHarnesses").mockImplementation(() => gate.promise);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const requests = createWorkspaceRequests(service, {
      chooseProject: async () => null,
      chooseDesign: async () => null,
      openExternal: async () => {},
      showItemInFolder() {},
    });
    const result = await Promise.race([
      requests.invoke("bootstrap", undefined, undefined),
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Workspace waited for harness discovery")),
          1000,
        );
      }),
    ]);
    expect(result).toMatchObject({ activeProject: { project: { id: project.id } }, harnesses: [] });
    const refresh = requests.invoke("harnesses", undefined, undefined);
    gate.resolve([{ id: "codex", name: "Codex", status: "ready" }]);
    expect(await refresh).toEqual([{ id: "codex", name: "Codex", status: "ready" }]);
    expect(probe).toHaveBeenCalledTimes(1);
  } finally {
    clearTimeout(deadline);
    gate.resolve([]);
    probe.mockRestore();
  }
});

test("project selections stay ordered across handlers and release after failure", async () => {
  const { service, store, project, directory } = await fixture();
  const secondPath = join(directory, "second-project");
  await mkdir(secondPath);
  const second = await store.open(secondPath);
  const platform = {
    chooseProject: async () => null,
    chooseDesign: async () => null,
    openExternal: async () => {},
    showItemInFolder() {},
  };
  const local = createWorkspaceRequests(service, platform);
  const remote = createWorkspaceRequests(service, platform);
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const access = service.assertProjectAccess.bind(service);
  let first = true;
  const checkAccess = spyOn(service, "assertProjectAccess").mockImplementation(async (id) => {
    if (first) {
      first = false;
      entered.resolve();
      await gate.promise;
    }
    return access(id);
  });
  const selected = spyOn(store, "select");
  try {
    const earlier = local.invoke("select-project", project.id, undefined);
    await entered.promise;
    const later = remote.invoke("select-project", second.project.id, undefined);
    // Unrelated requests remain responsive while the first access check is held.
    await remote.invoke("project-snapshot", second.project.id, undefined);
    expect(selected).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([earlier, later]);
    expect(selected.mock.calls.map(([id]) => id)).toEqual([project.id, second.project.id]);
    expect(store.activeProjectId).toBe(second.project.id);

    selected.mockRejectedValueOnce(new Error("Selection failed"));
    const rejected = local.invoke("select-project", project.id, undefined);
    const recovered = remote.invoke("select-project", second.project.id, undefined);
    await expect(rejected).rejects.toThrow("Selection failed");
    await recovered;
    expect(store.activeProjectId).toBe(second.project.id);
    const reopened = new ProjectStore(join(directory, "app"));
    await reopened.initialize();
    expect(reopened.activeProjectId).toBe(second.project.id);
  } finally {
    gate.resolve();
    selected.mockRestore();
    checkAccess.mockRestore();
  }
});

test("video previews resolve the authorized thread execution project and recheck workspace access", async () => {
  const { directory, store, service, project } = await fixture();
  const cloudRoot = join(directory, "workspace");
  await mkdir(cloudRoot);
  const workspace = (await store.open(cloudRoot, "Team")).project;
  let allowed = true;
  service.authorizeCloudProject = async () => {
    if (!allowed) throw new Error("Workspace access revoked");
  };
  const thread = await service.startThread({
    projectId: workspace.id,
    executionProjectId: project.id,
    harness: "codex",
    prompt: "Record feature",
    designIds: [],
  });
  await writeFile(join(project.path, "demo.mp4"), "execution recording");
  await writeFile(join(cloudRoot, "demo.mp4"), "workspace content");
  const requests = createWorkspaceRequests(service, {
    chooseProject: async () => null,
    chooseDesign: async () => null,
    openExternal: async () => {},
    showItemInFolder() {},
  });
  const input = { projectId: workspace.id, threadId: thread.id, href: "demo.mp4", offset: 0 };
  const result = await requests.invoke("read-video-chunk", input, undefined);
  const chunk = videoChunkSchema.parse(result);
  expect(Buffer.from(chunk.data, "base64").toString()).toBe("execution recording");
  allowed = false;
  await expect(
    requests.invoke("read-video-chunk", { ...input, href: join(cloudRoot, "demo.mp4") }, undefined),
  ).rejects.toThrow("revoked");
});

test("video continuation chunks reuse validated summaries without transcript reads or clones", async () => {
  const { service, store, project, runs } = await fixture();
  const thread = await service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Record feature",
    designIds: [],
  });
  await writeFile(join(project.path, "demo.mp4"), Buffer.alloc(1024 * 1024 + 7, 9));
  const input = { projectId: project.id, threadId: thread.id, href: "demo.mp4", offset: 0 };
  const read = spyOn(store, "readThread");
  const clone = spyOn(globalThis, "structuredClone");
  try {
    const first = await service.readVideoChunk(input);
    await service.readVideoChunk({ ...input, offset: 512 * 1024, revision: first.revision });
    expect(read).not.toHaveBeenCalled();
    expect(
      clone.mock.calls.some(
        ([value]) =>
          value &&
          typeof value === "object" &&
          "messages" in value &&
          "id" in value &&
          value.id === thread.id,
      ),
    ).toBe(false);
  } finally {
    read.mockRestore();
    clone.mockRestore();
  }
  const completed = finished(service, thread.id);
  runs[0].complete();
  await completed;
  const first = await service.readVideoChunk(input);
  const cold = spyOn(store, "readThread");
  try {
    await Promise.all(
      [512 * 1024, 1024 * 1024].map((offset) =>
        service.readVideoChunk({ ...input, offset, revision: first.revision }),
      ),
    );
    expect(cold).not.toHaveBeenCalled();
  } finally {
    cold.mockRestore();
  }
  const value = await store.readThread(project.id, thread.id);
  await writeFile(
    await store.storagePath(project.id, "threads", thread.id),
    JSON.stringify({ ...value, projectId: crypto.randomUUID() }),
  );
  await expect(
    service.readVideoChunk({ ...input, offset: 512 * 1024, revision: first.revision }),
  ).rejects.toThrow("another project");
});

const namingPreferences = { mode: "automatic", provider: "thread", instructions: "" } as const;

test("background naming does not block starting, and a manual rename wins over a late generated title", async () => {
  const generation = Promise.withResolvers<string>();
  const requested =
    Promise.withResolvers<
      Parameters<NonNullable<ConstructorParameters<typeof WorkspaceService>[5]>>[0]
    >();
  const f = await fixture(undefined, false, undefined, false, (input) => {
    requested.resolve(input);
    return generation.promise;
  });
  const thread = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "Improve navigation",
    designIds: [],
    naming: namingPreferences,
  });
  expect(thread.title).toBe("Improve navigation");
  expect(thread.status).toBe("running");
  const input = await requested.promise;
  expect(input.prompt).toBe("Improve navigation");
  const renamed = await f.service.renameThread(f.project.id, thread.id, "Navigation polish");
  expect(input.signal.aborted).toBe(true);
  generation.resolve("Late generated title");
  const final = finished(f.service, thread.id);
  f.runs[0].complete();
  await final;
  expect((await f.service.readThread(f.project.id, thread.id)).title).toBe("Navigation polish");
  expect(renamed.updatedAt).toBe(thread.updatedAt);
  expect(renamed.titleSource).toBe("manual");
  expect(renamed.messages).toEqual(thread.messages);
});

test("regeneration uses the selected provider without resuming or changing the working conversation", async () => {
  let requested:
    | Parameters<NonNullable<ConstructorParameters<typeof WorkspaceService>[5]>>[0]
    | undefined;
  const f = await fixture(undefined, false, undefined, false, async (input) => {
    requested = input;
    return "Refine the sidebar";
  });
  const thread = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "Please refine the sidebar layout",
    designIds: [],
    settings: { model: "codex-model" },
  });
  const result = await f.service.regenerateThreadTitle(f.project.id, thread.id, {
    ...namingPreferences,
    provider: "claude",
    instructions: "Keep it brief",
  });
  expect(requested?.harness).toBe("claude");
  expect(requested?.model).toBeUndefined();
  expect(requested?.instructions).toBe("Keep it brief");
  expect(result.title).toBe("Refine the sidebar");
  expect(result.titleSource).toBe("generated");
  expect(result.updatedAt).toBe(thread.updatedAt);
  expect(result.messages).toEqual(thread.messages);
  expect(result.status).toBe("running");
  expect(f.runs).toHaveLength(1);
  f.runs[0].input.onUpdate({ type: "message", id: "response", text: "Still working" });
  const final = finished(f.service, thread.id);
  f.runs[0].complete();
  expect((await final).title).toBe(result.title);
  expect((await f.store.readThread(f.project.id, thread.id)).title).toBe(result.title);
});

test("failed generation keeps the previous name and latest regeneration wins", async () => {
  const first = Promise.withResolvers<string>();
  const firstStarted = Promise.withResolvers<void>();
  let calls = 0;
  const f = await fixture(undefined, false, undefined, false, async () => {
    calls++;
    if (calls === 1) {
      firstStarted.resolve();
      return first.promise;
    }
    if (calls === 2) return "Current title";
    throw new Error("Provider unavailable");
  });
  const thread = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "Improve the sidebar",
    designIds: [],
  });
  const pending = f.service.regenerateThreadTitle(f.project.id, thread.id, namingPreferences);
  await firstStarted.promise;
  const current = await f.service.regenerateThreadTitle(f.project.id, thread.id, namingPreferences);
  first.resolve("Outdated title");
  expect((await pending).title).toBe("Current title");
  expect(current.title).toBe("Current title");
  await expect(
    f.service.regenerateThreadTitle(f.project.id, thread.id, namingPreferences),
  ).rejects.toThrow("Provider unavailable");
  expect((await f.service.readThread(f.project.id, thread.id)).title).toBe("Current title");
});

test("prompt naming makes no inference call and naming endpoints validate access and input", async () => {
  let calls = 0;
  const f = await fixture(undefined, false, undefined, false, async () => {
    calls++;
    return "Should not run";
  });
  const thread = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "Improve the sidebar",
    designIds: [],
    naming: { ...namingPreferences, mode: "prompt" },
  });
  expect(calls).toBe(0);
  expect(() => f.service.renameThread(f.project.id, thread.id, " ")).toThrow();
  const other = await f.store.open(await mkdtemp(join(f.directory, "other-")));
  await expect(
    f.service.renameThread(other.project.id, thread.id, "Wrong project"),
  ).rejects.toThrow();
  await expect(
    f.service.regenerateThreadTitle(other.project.id, thread.id, namingPreferences),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("a failed rename restores the current name and cancels a generated replacement", async () => {
  const requested = Promise.withResolvers<AbortSignal>();
  const f = await fixture(undefined, false, undefined, false, (input) => {
    requested.resolve(input.signal);
    return new Promise((_, reject) =>
      input.signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }),
    );
  });
  const thread = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "Improve the sidebar",
    designIds: [],
    naming: namingPreferences,
  });
  const signal = await requested.promise;
  const failure = spyOn(f.store, "writeThread").mockRejectedValueOnce(new Error("Disk full"));
  await expect(f.service.renameThread(f.project.id, thread.id, "Unwritten title")).rejects.toThrow(
    "Disk full",
  );
  failure.mockRestore();
  expect((await f.service.readThread(f.project.id, thread.id)).title).toBe(thread.title);
  expect(signal.aborted).toBe(true);
  await f.service.close();
  expect((await f.store.readThread(f.project.id, thread.id)).title).toBe(thread.title);
});

test("shutdown cancels in-flight naming without waiting for the provider", async () => {
  const requested = Promise.withResolvers<AbortSignal>();
  const f = await fixture(undefined, false, undefined, false, (input) => {
    requested.resolve(input.signal);
    return new Promise((_, reject) =>
      input.signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }),
    );
  });
  const thread = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "Improve the sidebar",
    designIds: [],
    naming: namingPreferences,
  });
  const signal = await requested.promise;
  await f.service.close();
  expect(signal.aborted).toBe(true);
  expect((await f.store.readThread(f.project.id, thread.id)).title).toBe(thread.title);
});

for (const shutdown of ["update", "quit"] as const) {
  for (const stage of ["access", "discovery"] as const) {
    test(`${shutdown} releases naming preparation stalled at ${stage} before stopping the working thread`, async () => {
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      let held = false;
      let generations = 0;
      const f = await fixture(
        undefined,
        false,
        undefined,
        false,
        async () => {
          generations++;
          return "Generated name";
        },
        async () => {
          if (stage === "discovery" && held) {
            entered.resolve();
            await gate.promise;
          }
          return "/fixture/harness";
        },
      );
      const thread = await f.service.startThread({
        projectId: f.project.id,
        harness: "codex",
        prompt: "Improve navigation",
        designIds: [],
      });
      held = true;
      const access =
        stage === "access"
          ? spyOn(f.service, "assertProjectAccess").mockImplementation(async () => {
              entered.resolve();
              await gate.promise;
            })
          : undefined;
      const pending = f.service
        .dispatch(() => f.service.regenerateThreadTitle(f.project.id, thread.id, namingPreferences))
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await entered.promise;
      try {
        if (shutdown === "update") {
          const restore = await f.service.prepareUpdate();
          restore();
        } else await f.service.close(50);
        expect(f.runs[0].stopped).toBe(true);
        expect((await pending) instanceof Error).toBe(true);
        gate.resolve();
        await Promise.resolve();
        expect(generations).toBe(0);
        expect((await f.store.readThread(f.project.id, thread.id)).title).toBe(thread.title);
      } finally {
        gate.resolve();
        access?.mockRestore();
      }
    }, 2000);
  }
}

test("quit bounds the wait for a naming provider that ignores cancellation", async () => {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<string>();
  const f = await fixture(undefined, false, undefined, false, async () => {
    entered.resolve();
    return gate.promise;
  });
  const thread = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "Improve navigation",
    designIds: [],
    naming: namingPreferences,
  });
  await entered.promise;
  try {
    await f.service.close(25);
    expect(f.runs[0].stopped).toBe(true);
    gate.resolve("A late title");
    await Promise.resolve();
    expect((await f.store.readThread(f.project.id, thread.id)).title).toBe(thread.title);
  } finally {
    gate.resolve("A late title");
  }
}, 2000);

test("naming requested after shutdown never starts an access check", async () => {
  const f = await fixture();
  const thread = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "Improve navigation",
    designIds: [],
  });
  await f.service.close();
  const access = spyOn(f.service, "assertProjectAccess").mockImplementation(
    () => new Promise(() => {}),
  );
  try {
    await expect(
      f.service.regenerateThreadTitle(f.project.id, thread.id, namingPreferences),
    ).rejects.toThrow("closing");
    expect(access).not.toHaveBeenCalled();
  } finally {
    access.mockRestore();
  }
}, 1000);
