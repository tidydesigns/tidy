import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread, HarnessId } from "../../shared/contracts/desktop";
import type { startHarness, RunningHarness } from "../harnesses/harnesses";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tidy-update-resume-"));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const directory = join(root, "private");
  const runs: { input: Parameters<typeof startHarness>[0]; finish(): void; stopped: boolean }[] =
    [];
  let saveSession = true;
  let deliveryState: RunningHarness["deliveryState"] = "accepted";
  let acceptOnStop = false;
  async function boot() {
    const store = new ProjectStore(directory);
    await store.initialize();
    await store.recover();
    const service = new WorkspaceService(
      store,
      (input) => {
        const done = Promise.withResolvers<void>();
        const run = { input, finish: () => done.resolve(), stopped: false };
        runs.push(run);
        if (saveSession) input.onUpdate({ type: "session", id: input.sessionId ?? randomUUID() });
        return {
          done: done.promise,
          get deliveryState() {
            return deliveryState;
          },
          stop() {
            if (acceptOnStop) deliveryState = "accepted";
            run.stopped = true;
            done.resolve();
          },
        };
      },
      async () => "/fixture/agent",
      async () => {},
    );
    cleanups.push(() => service.close());
    return { store, service };
  }
  const initial = await boot();
  await mkdir(join(root, "project"));
  const { project } = await initial.store.open(join(root, "project"));
  const start = (harness: HarnessId = "codex", prompt = "Finish the work") =>
    initial.service.startThread({ projectId: project.id, harness, prompt, designIds: [] });
  return {
    ...initial,
    project,
    start,
    runs,
    boot,
    directory,
    setDelivery(state: RunningHarness["deliveryState"]) {
      deliveryState = state;
    },
    acceptWhileStopping() {
      acceptOnStop = true;
    },
    withoutSession() {
      saveSession = false;
    },
  };
}

function ended(service: WorkspaceService, id: string) {
  return new Promise<Thread>((resolve) => {
    const off = service.subscribe((event) => {
      if (event.type === "thread" && event.thread.id === id && event.thread.status !== "running") {
        off();
        resolve(event.thread);
      }
    });
  });
}

test("a fresh backend resumes all update-interrupted sessions once, retaining partial replies and queued work", async () => {
  const f = await fixture();
  const first = await f.start("codex");
  const second = await f.start("claude");
  f.runs[0].input.onUpdate({ type: "message", id: "reply", text: "Partial reply" });
  const queued = await f.service.sendMessage({
    projectId: f.project.id,
    threadId: first.id,
    text: "Then check it",
    delivery: "queue",
  });
  const before = await f.service.readThread(f.project.id, first.id);
  await f.service.prepareUpdate();
  expect(f.runs.every((run) => run.stopped)).toBe(true);
  expect((await stat(join(f.directory, "update-resumes.json"))).mode & 0o777).toBe(0o600);
  const reopened = await f.boot();
  await Promise.all([
    reopened.service.resumeUpdatedThreads(),
    reopened.service.resumeUpdatedThreads(),
  ]);
  expect(f.runs).toHaveLength(4);
  expect(
    f.runs
      .slice(2)
      .map((run) => run.input.sessionId)
      .sort(),
  ).toEqual(
    [
      (await f.store.readThread(f.project.id, first.id)).sessionId,
      (await f.store.readThread(f.project.id, second.id)).sessionId,
    ].sort(),
  );
  const resumed = await reopened.service.readThread(f.project.id, first.id);
  expect(resumed.status).toBe("running");
  expect(resumed.messages.map((message) => [message.id, message.text])).toEqual(
    before.messages.map((message) => [message.id, message.text]),
  );
  expect(resumed.messages[0].turn?.startedAt).toBe(before.messages[0].turn?.startedAt);
  expect(resumed.messages[0].turn?.endedAt).toBeUndefined();
  expect(resumed.queuedMessages).toEqual(queued.queuedMessages);
  const done = ended(reopened.service, first.id);
  f.runs.find((run, index) => index >= 2 && run.input.sessionId === resumed.sessionId)!.finish();
  await done;
  // The automatic queue is restored along with the interrupted request.
  for (let attempt = 0; attempt < 100 && f.runs.length < 5; attempt++) await Bun.sleep(5);
  expect(f.runs).toHaveLength(5);
  expect(f.runs[4].input.prompt).toContain("Then check it");
  await reopened.service.resumeUpdatedThreads();
  expect(f.runs).toHaveLength(5);
  expect(await reopened.store.updateResumes.list()).toEqual([]);
});

test("completed, manually stopped and crash-interrupted threads never acquire update restart intent", async () => {
  const f = await fixture();
  const completed = await f.start();
  const done = ended(f.service, completed.id);
  f.runs[0].finish();
  await done;
  const stopped = await f.start();
  const stop = ended(f.service, stopped.id);
  await f.service.stopThread(f.project.id, stopped.id);
  await stop;
  await f.service.prepareUpdate();
  const reopened = await f.boot();
  await reopened.service.resumeUpdatedThreads();
  expect(f.runs).toHaveLength(2);
  const crash = {
    ...(await f.store.readThread(f.project.id, stopped.id)),
    status: "running" as const,
  };
  await f.store.writeThread(crash);
  const crashed = await f.boot();
  await crashed.service.resumeUpdatedThreads();
  expect((await crashed.store.readThread(f.project.id, crash.id)).status).toBe("interrupted");
  expect(f.runs).toHaveLength(2);
});

for (const change of ["stop", "done", "settings", "portable prompt"] as const) {
  test(`${change} after checkpoint cancels automatic continuation`, async () => {
    const f = await fixture();
    const thread = await f.start();
    await f.service.prepareUpdate();
    const reopened = await f.boot();
    if (change === "stop") await reopened.service.stopThread(f.project.id, thread.id);
    if (change === "done") await reopened.service.setThreadDone(f.project.id, thread.id, true);
    if (change === "settings")
      await reopened.service.setThreadSettings(f.project.id, thread.id, { model: "changed" });
    if (change === "portable prompt") {
      const path = join(f.project.path, ".tidy", "threads", `${thread.id}.json`);
      const portable = JSON.parse(await readFile(path, "utf8"));
      portable.messages[0].text = "Run a different command";
      await writeFile(path, JSON.stringify(portable));
    }
    await reopened.service.resumeUpdatedThreads();
    expect(f.runs).toHaveLength(1);
    expect(await reopened.store.updateResumes.list()).toEqual([]);
  });
}

test("a failed native restart resumes work in the existing app and does not revive it on a later launch", async () => {
  const f = await fixture();
  const thread = await f.start();
  const restore = await f.service.prepareUpdate();
  restore();
  await f.service.resumeUpdatedThreads();
  expect(f.runs).toHaveLength(2);
  expect((await f.service.readThread(f.project.id, thread.id)).status).toBe("running");
  restore();
  await f.service.resumeUpdatedThreads();
  expect(f.runs).toHaveLength(2);
  await f.service.close();
  const reopened = await f.boot();
  await reopened.service.resumeUpdatedThreads();
  expect(f.runs).toHaveLength(2);
});

test("missing native sessions fail visibly without replaying the original request", async () => {
  const f = await fixture();
  f.withoutSession();
  const thread = await f.start();
  await f.service.prepareUpdate();
  const reopened = await f.boot();
  await reopened.service.resumeUpdatedThreads();
  expect(f.runs).toHaveLength(1);
  expect((await reopened.store.readThread(f.project.id, thread.id)).error).toContain(
    "had not saved its session",
  );
  expect(await reopened.store.updateResumes.list()).toEqual([]);
});

test("an update before the first native submission sends the original request once without duplicating its message", async () => {
  const f = await fixture();
  f.withoutSession();
  f.setDelivery("not-submitted");
  const thread = await f.start("codex", "The original request before the agent was ready");
  await f.service.prepareUpdate();
  f.setDelivery("accepted");
  const reopened = await f.boot();
  await reopened.service.resumeUpdatedThreads();
  expect(f.runs).toHaveLength(2);
  expect(f.runs[1].input.prompt).toContain(thread.messages[0].text);
  expect(f.runs[1].input.prompt).not.toContain("Continue the unfinished user request");
  expect(
    (await reopened.service.readThread(f.project.id, thread.id)).messages.map(
      (message) => message.id,
    ),
  ).toEqual(thread.messages.map((message) => message.id));
});

test("a queued request interrupted before submission is delivered instead of continuing the previous completed task", async () => {
  const f = await fixture();
  const thread = await f.start("codex", "A task that is already finished");
  const complete = ended(f.service, thread.id);
  f.runs[0].finish();
  await complete;
  f.setDelivery("not-submitted");
  const messageId = randomUUID();
  await f.service.sendMessage({
    projectId: f.project.id,
    threadId: thread.id,
    text: "A different task waiting to be submitted",
    messageId,
    delivery: "queue",
  });
  await f.service.prepareUpdate();
  f.setDelivery("accepted");
  const reopened = await f.boot();
  await reopened.service.resumeUpdatedThreads();
  expect(f.runs).toHaveLength(3);
  expect(f.runs[2].input.prompt).toContain("A different task waiting to be submitted");
  expect(f.runs[2].input.prompt).not.toContain("Continue the unfinished user request");
  const resumed = await reopened.service.readThread(f.project.id, thread.id);
  expect(resumed.messages.filter((message) => message.id === messageId)).toHaveLength(1);
  expect(resumed.queuedMessages).toHaveLength(0);
});

test.each(["unknown", "rejected"] as const)(
  "a %s submission is not automatically retried against an older native session",
  async (state) => {
    const f = await fixture();
    const thread = await f.start();
    f.setDelivery(state);
    await f.service.prepareUpdate();
    const reopened = await f.boot();
    await reopened.service.resumeUpdatedThreads();
    expect(f.runs).toHaveLength(1);
    expect((await reopened.store.readThread(f.project.id, thread.id)).error).toContain(
      "did not confirm",
    );
  },
);

test("a request accepted while update cancellation is in flight is continued rather than submitted again", async () => {
  const f = await fixture();
  f.setDelivery("not-submitted");
  await f.start("codex", "An action that must only be submitted once");
  f.acceptWhileStopping();
  await f.service.prepareUpdate();
  const reopened = await f.boot();
  await reopened.service.resumeUpdatedThreads();
  expect(f.runs).toHaveLength(2);
  expect(f.runs[1].input.prompt).toContain("Continue the unfinished user request");
  expect(f.runs[1].input.prompt).not.toContain("An action that must only be submitted once");
});

for (const interruption of ["stop", "quit", "another update"] as const) {
  test(`${interruption} while recovery consumes its journal cannot cause a late or duplicate launch`, async () => {
    const f = await fixture();
    const thread = await f.start();
    await f.service.prepareUpdate();
    const reopened = await f.boot();
    const consumed = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const take = reopened.store.updateResumes.take.bind(reopened.store.updateResumes);
    reopened.store.updateResumes.take = async (entry) => {
      const result = await take(entry);
      consumed.resolve();
      await gate.promise;
      return result;
    };
    const recovery = reopened.service.resumeUpdatedThreads();
    try {
      await consumed.promise;
      let closing: Promise<unknown> | undefined;
      if (interruption === "stop") await reopened.service.stopThread(f.project.id, thread.id);
      if (interruption === "quit") closing = reopened.service.close();
      if (interruption === "another update") closing = reopened.service.prepareUpdate();
      gate.resolve();
      await Promise.all([recovery, closing]);
      expect(f.runs).toHaveLength(1);
      const next = await f.boot();
      await next.service.resumeUpdatedThreads();
      expect(f.runs).toHaveLength(interruption === "another update" ? 2 : 1);
    } finally {
      gate.resolve();
      await recovery;
    }
  });
}

test("ordinary quit after preparing an update cancels its automatic continuation", async () => {
  const f = await fixture();
  await f.start();
  await f.service.prepareUpdate();
  await f.service.close();
  const reopened = await f.boot();
  await reopened.service.resumeUpdatedThreads();
  expect(f.runs).toHaveLength(1);
});

for (const action of ["stop", "quit"] as const) {
  test(`a corrupt recovery journal cannot block ${action} or leave its native run alive`, async () => {
    const f = await fixture();
    const thread = await f.start();
    await writeFile(join(f.directory, "update-resumes.json"), "{malformed");
    if (action === "stop") {
      const done = ended(f.service, thread.id);
      await f.service.stopThread(f.project.id, thread.id);
      await done;
    } else await f.service.close();
    expect(f.runs[0].stopped).toBe(true);
    expect(await f.store.updateResumes.list()).toEqual([]);
  });
}

test("failure to clear restart intent on quit still terminates active native work", async () => {
  const f = await fixture();
  await f.start();
  const clear = f.store.updateResumes.clear.bind(f.store.updateResumes);
  f.store.updateResumes.clear = async () => {
    throw new Error("Journal disk failure");
  };
  try {
    await expect(f.service.close()).rejects.toThrow("Journal disk failure");
    expect(f.runs[0].stopped).toBe(true);
  } finally {
    f.store.updateResumes.clear = clear;
  }
});

test("Stop during restored cloud authorization prevents a late automatic launch", async () => {
  const f = await fixture();
  await mkdir(join(f.directory, "workspace"));
  const cloud = await f.store.register(join(f.directory, "workspace"), "Cloud");
  f.service.authorizeCloudProject = async () => {};
  const thread = await f.service.startThread({
    projectId: cloud.id,
    executionProjectId: f.project.id,
    harness: "codex",
    prompt: "Work",
    designIds: [],
  });
  await f.service.prepareUpdate();
  const reopened = await f.boot();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  reopened.service.restoreUpdateAccess = async () => {
    entered.resolve();
    await gate.promise;
  };
  reopened.service.authorizeCloudProject = async () => {};
  const recovery = reopened.service.resumeUpdatedThreads();
  await entered.promise;
  await reopened.service.stopThread(cloud.id, thread.id);
  gate.resolve();
  await recovery;
  expect(f.runs).toHaveLength(1);
});
