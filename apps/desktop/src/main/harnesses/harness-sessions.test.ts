import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { BrowserService } from "../browser/browser-service";
import { BrowserAgentBridge } from "../browser/agent-bridge";
import { HarnessSession } from "./interactive-harness";
import { HarnessSessions } from "./harness-sessions";
import { harnessIdSchema, nativeSessionIdSchema } from "../../shared/contracts/desktop";
import type { HarnessUpdate } from "./harnesses";
let directory: string;
let executable: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "tidy-sessions-"));
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures/session-agent.ts")],
    outdir: directory,
    target: "node",
    packages: "bundle",
  });
  if (!result.success) throw new AggregateError(result.logs);
  executable = result.outputs[0].path;
  await chmod(executable, 0o700);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
const eventsSchema = z.array(
  z.object({
    pid: z.number(),
    method: z.string().optional(),
    type: z.string().optional(),
    value: z.object({ params: z.unknown().optional(), message: z.unknown().optional() }),
  }),
);

test("a native Claude update preserves compatible follow-ups while its existing session has background work", async () => {
  const { ProjectStore } = await import("../workspace/project-store");
  const { WorkspaceService } = await import("../workspace/workspace-service");
  const cwd = await mkdtemp(join(directory, "claude-native-update-"));
  const store = new ProjectStore(join(cwd, "private"));
  await store.initialize();
  const { project } = await store.open(cwd);
  let installedExecutable = executable;
  const service = new WorkspaceService(
    store,
    undefined,
    async () => installedExecutable,
    async () => {},
  );
  const finished = () =>
    new Promise<string>((resolve) => {
      const off = service.subscribe((event) => {
        if (event.type === "thread" && event.thread.status !== "running") {
          off();
          resolve(event.thread.status);
        }
      });
    });
  try {
    const first = finished();
    const thread = await service.startThread({
      projectId: project.id,
      harness: "claude",
      prompt: "background silent",
      designIds: [],
    });
    expect(await first).toBe("completed");
    const release = service.reserveHarnessUpdate("claude", { allowActiveRuns: true });
    expect(release).not.toBeNull();
    // Claude's native updater advances a versioned symlink, changing the resolved CLI path.
    const replacement = join(cwd, "updated-claude");
    await copyFile(executable, replacement);
    await chmod(replacement, 0o700);
    installedExecutable = replacement;
    release!();
    const next = finished();
    await service.sendMessage({
      projectId: project.id,
      threadId: thread.id,
      text: "Continue after the native update",
    });
    expect(await next).toBe("completed");
    expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(1);
  } finally {
    await service.close();
  }
});
async function events(cwd: string) {
  return eventsSchema.parse(
    (await readFile(join(cwd, "session-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );
}

test("native upgrade rollover never relaxes the permissions or project of retained background work", async () => {
  const cwd = await mkdtemp(join(directory, "native-upgrade-boundary-"));
  const replacement = join(cwd, "updated-claude");
  await copyFile(executable, replacement);
  await chmod(replacement, 0o700);
  const sessions = new HarnessSessions();
  const context = {
    projectId: "project",
    harness: "claude" as const,
    executable,
    cwd,
    settings: { permissionMode: "plan" as const },
  };
  let sessionId: string | undefined;
  try {
    await sessions.start("thread", {
      ...context,
      prompt: "background silent",
      onUpdate(update) {
        if (update.type === "session") sessionId = update.id;
      },
    }).done;
    await sessions.clear({ harness: "claude", idleOnly: true, preserveActive: true });
    for (const changed of [
      { ...context, projectId: "other-project" },
      { ...context, settings: { permissionMode: "auto" as const } },
      { ...context, settings: { ...context.settings, model: "another-model" } },
    ])
      await expect(
        sessions.start("thread", {
          ...changed,
          executable: replacement,
          sessionId,
          prompt: "Must not run",
          onUpdate() {},
        }).done,
      ).rejects.toThrow("background work");
    await sessions.start("thread", {
      ...context,
      executable: replacement,
      sessionId,
      prompt: "Compatible follow-up",
      onUpdate() {},
    }).done;
    expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(1);
  } finally {
    await sessions.clear();
  }
});

for (const harness of harnessIdSchema.options) {
  for (const background of [false, true]) {
    test(`${harness} resumes ${background ? "background work" : "an active turn"} through a fresh backend after an update`, async () => {
      const { ProjectStore } = await import("../workspace/project-store");
      const { WorkspaceService } = await import("../workspace/workspace-service");
      const cwd = await mkdtemp(join(directory, `${harness}-update-`));
      const state = join(cwd, "private");
      const store = new ProjectStore(state);
      await store.initialize();
      const { project } = await store.open(cwd);
      const service = new WorkspaceService(
        store,
        undefined,
        async () => executable,
        async () => {},
      );
      let reopened: InstanceType<typeof WorkspaceService> | undefined;
      const ready = Promise.withResolvers<void>();
      service.subscribe((event) => {
        if (event.type !== "thread" && event.type !== "thread-patch") return;
        if (background ? event.thread.status === "completed" : Boolean(event.thread.sessionId))
          ready.resolve();
      });
      try {
        const thread = await service.startThread({
          projectId: project.id,
          harness,
          prompt: background ? "background silent" : "hold",
          designIds: [],
        });
        await ready.promise;
        expect(service.activeRunCount).toBe(1);
        const before = await service.readThread(project.id, thread.id);
        await service.prepareUpdate();
        expect(service.activeRunCount).toBe(0);
        const nextStore = new ProjectStore(state);
        await nextStore.initialize();
        await nextStore.recover();
        reopened = new WorkspaceService(
          nextStore,
          undefined,
          async () => executable,
          async () => {},
        );
        const completed = Promise.withResolvers<void>();
        reopened.subscribe((event) => {
          if (event.type === "thread" && event.thread.status === "completed") completed.resolve();
        });
        await reopened.resumeUpdatedThreads();
        await completed.promise;
        const after = await reopened.readThread(project.id, thread.id);
        expect(after.sessionId).toBe(before.sessionId);
        expect(after.messages.filter((message) => message.role === "user")).toEqual(
          before.messages
            .filter((message) => message.role === "user")
            .map((message) => ({ ...message, turn: after.messages[0].turn })),
        );
        expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(2);
        expect(await nextStore.updateResumes.list()).toEqual([]);
      } finally {
        await reopened?.close();
        await service.close();
      }
    }, 10_000);
  }
}

for (const harness of harnessIdSchema.options) {
  test(`${harness} rejects incompatible settings before persisting them and continues background work on the same session`, async () => {
    const { ProjectStore } = await import("../workspace/project-store");
    const { WorkspaceService } = await import("../workspace/workspace-service");
    const cwd = await mkdtemp(join(directory, `${harness}-background-settings-`));
    const store = new ProjectStore(join(cwd, "private"));
    await store.initialize();
    const { project } = await store.open(cwd);
    let validations = 0;
    const service = new WorkspaceService(
      store,
      undefined,
      async () => executable,
      async () => {
        validations++;
      },
    );
    const finished = () =>
      new Promise<import("../../shared/contracts/desktop").Thread>((resolve) => {
        const off = service.subscribe((event) => {
          if (event.type === "thread" && event.thread.status !== "running") {
            off();
            resolve(event.thread);
          }
        });
      });
    try {
      let done = finished();
      const thread = await service.startThread({
        projectId: project.id,
        harness,
        prompt: "background silent",
        designIds: [],
      });
      const original = await done;
      const pid = (await events(cwd))[0].pid;
      for (const settings of [
        { ...original.settings, model: "another-model" },
        { ...original.settings, effort: "high" },
      ]) {
        await expect(service.setThreadSettings(project.id, thread.id, settings)).rejects.toThrow(
          "Keep its current",
        );
        expect((await store.readThread(project.id, thread.id)).settings).toEqual(original.settings);
        expect((await store.readThread(project.id, thread.id)).revision).toBe(original.revision);
      }
      // Block before catalog/network discovery; default and explicitly selected default are equivalent.
      expect(validations).toBe(0);
      await service.setThreadSettings(project.id, thread.id, {
        permissionMode: "default",
      });
      done = finished();
      await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "continue" });
      expect((await done).status).toBe("completed");
      expect(new Set((await events(cwd)).map((event) => event.pid))).toEqual(new Set([pid]));
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      await service.close();
    }
  });
}

test("a retained-session conflict leaves the follow-up unsent and can recover a previously saved incompatible setting", async () => {
  const { ProjectStore } = await import("../workspace/project-store");
  const { WorkspaceService } = await import("../workspace/workspace-service");
  const cwd = await mkdtemp(join(directory, "background-preflight-"));
  const store = new ProjectStore(join(cwd, "private"));
  await store.initialize();
  const { project } = await store.open(cwd);
  const service = new WorkspaceService(
    store,
    undefined,
    async () => executable,
    async () => {},
  );
  const finished = () =>
    new Promise<import("../../shared/contracts/desktop").Thread>((resolve) => {
      const off = service.subscribe((event) => {
        if (event.type === "thread" && event.thread.status !== "running") {
          off();
          resolve(event.thread);
        }
      });
    });
  try {
    let done = finished();
    const thread = await service.startThread({
      projectId: project.id,
      harness: "codex",
      prompt: "background silent",
      designIds: [],
    });
    const original = await done;
    const pid = (await events(cwd))[0].pid;
    // Simulate a settings change saved by an older app while the native session is still running.
    const incompatible = {
      ...original,
      settings: { permissionMode: "auto" as const },
      revision: original.revision + 1,
    };
    await store.writeThread(incompatible);
    const before = await events(cwd);
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(
        service.sendMessage({ projectId: project.id, threadId: thread.id, text: "continue" }),
      ).rejects.toThrow("background work");
    const after = await store.readThread(project.id, thread.id);
    expect(after.messages).toEqual(original.messages);
    expect(after.status).toBe("completed");
    expect(after.revision).toBe(incompatible.revision);
    expect(await events(cwd)).toEqual(before);
    // Stop releases the stale background session even if an old app saved incompatible settings.
    await service.stopThread(project.id, thread.id);
    done = finished();
    await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "continue" });
    expect((await done).status).toBe("completed");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(2);
  } finally {
    await service.close();
  }
});

for (const scope of ["harness", "project", "repository", "thread"] as const) {
  test(`clearing a ${scope} cancels matching queued acquisitions while preserving unrelated sends`, async () => {
    const cwd = await mkdtemp(join(directory, "scoped-clear-"));
    const sessions = new HarnessSessions();
    const context = { projectId: "local", harness: "codex" as const, executable, cwd };
    const clearedPath = join(cwd, "cloud");
    await mkdir(clearedPath);
    try {
      const local = sessions.start("local", { ...context, prompt: "Local", onUpdate() {} });
      const other = sessions.prepare({
        kind: "thread",
        id: "cloud",
        context: {
          ...context,
          projectId: "cloud",
          harness: "claude",
          cwd: clearedPath,
        },
      });
      const settled = Promise.allSettled([local.done, other]);
      await sessions.clear({
        idleOnly: true,
        ...(scope === "harness"
          ? { harness: "claude" as const }
          : scope === "project"
            ? { projectIds: new Set(["cloud"]) }
            : scope === "thread"
              ? { threadId: "cloud" }
              : { directory: clearedPath }),
      });
      expect(await settled).toEqual([
        { status: "fulfilled", value: undefined },
        {
          status: "rejected",
          reason: expect.objectContaining({ message: expect.stringContaining("context changed") }),
        },
      ]);
      expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(1);
    } finally {
      await sessions.clear();
    }
  });
}

test("settings selected during a native run persist for its next turn without interrupting it", async () => {
  const { ProjectStore } = await import("../workspace/project-store");
  const { WorkspaceService } = await import("../workspace/workspace-service");
  const cwd = await mkdtemp(join(directory, "running-settings-"));
  const store = new ProjectStore(join(cwd, "private"));
  await store.initialize();
  const { project } = await store.open(cwd);
  const service = new WorkspaceService(
    store,
    undefined,
    async () => executable,
    async () => {},
  );
  const finished = () =>
    new Promise<void>((resolve) => {
      const off = service.subscribe((event) => {
        if (event.type === "thread" && event.thread.status !== "running") {
          off();
          resolve();
        }
      });
    });
  try {
    const thread = await service.startThread({
      projectId: project.id,
      harness: "codex",
      prompt: "hold",
      designIds: [],
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await service.readThread(project.id, thread.id)).sessionId) break;
      await Bun.sleep(5);
    }
    expect((await service.readThread(project.id, thread.id)).sessionId).toBeDefined();
    const pid = (await events(cwd))[0].pid;
    const settings = {
      model: "another-model",
      effort: "high",
      permissionMode: "default" as const,
    };
    const changed = await service.setThreadSettings(project.id, thread.id, settings);
    expect(changed.status).toBe("running");
    expect(changed.settings).toEqual(settings);
    expect(() => process.kill(pid, 0)).not.toThrow();
    let done = finished();
    await service.stopThread(project.id, thread.id);
    await done;
    done = finished();
    await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "continue" });
    await done;
    expect((await store.readThread(project.id, thread.id)).settings).toEqual(settings);
    expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(2);
  } finally {
    await service.close();
  }
});

test("a duplicate start or incompatible preparation cannot close another running turn", async () => {
  const cwd = await mkdtemp(join(directory, "concurrent-start-"));
  const sessions = new HarnessSessions();
  const context = { projectId: "project", harness: "codex" as const, executable, cwd };
  const accepted = Promise.withResolvers<void>();
  try {
    const running = sessions.start("thread", {
      ...context,
      prompt: "hold",
      onUpdate(update) {
        if (update.type === "started") accepted.resolve();
      },
    });
    await accepted.promise;
    const pid = (await events(cwd))[0].pid;
    await expect(
      sessions.start("thread", { ...context, prompt: "duplicate", onUpdate() {} }).done,
    ).rejects.toThrow("running turn");
    await expect(
      sessions.prepare({
        kind: "thread",
        id: "thread",
        context: { ...context, settings: { model: "other" } },
      }),
    ).rejects.toThrow("Wait for");
    expect(() => process.kill(pid, 0)).not.toThrow();
    running.stop();
    await running.done;
    await sessions.start("thread", { ...context, prompt: "continue", onUpdate() {} }).done;
    expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(1);
  } finally {
    await sessions.clear();
  }
});

test("access withdrawal and project removal release scoped sessions and protect background work", async () => {
  const { ProjectStore } = await import("../workspace/project-store");
  const { WorkspaceService } = await import("../workspace/workspace-service");
  const cwd = await mkdtemp(join(directory, "cloud-retention-"));
  const initialized = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", "init", cwd]);
  if (initialized.exitCode !== 0) throw new Error("Could not initialize fixture repository.");
  const store = new ProjectStore(join(cwd, "state"));
  await store.initialize();
  const local = (await store.open(cwd)).project;
  const cloudPath = join(cwd, "cloud");
  await mkdir(cloudPath);
  const cloud = (await store.open(cloudPath, "Cloud workspace")).project;
  const service = new WorkspaceService(
    store,
    undefined,
    async () => executable,
    async () => {},
  );
  let allowed = true;
  service.canAccessCloudProject = () => allowed;
  service.authorizeCloudProject = async () => {
    if (!allowed) throw new Error("Cloud access withdrawn");
  };
  const completed = () =>
    new Promise<void>((resolve) => {
      const unsubscribe = service.subscribe((event) => {
        if (event.type === "thread" && event.thread.status === "completed") {
          unsubscribe();
          resolve();
        }
      });
    });
  try {
    await service.warmThread({ projectId: cloud.id, harness: "codex" });
    expect((await events(cloudPath)).some((event) => event.method === "thread/start")).toBe(true);
    const cloudDone = completed();
    const backgroundThread = await service.startThread({
      projectId: cloud.id,
      executionProjectId: local.id,
      harness: "codex",
      prompt: "background silent",
      designIds: [],
    });
    await cloudDone;
    expect(service.activeRunCount).toBe(1);
    const cloudPid = (await events(cwd))[0].pid;
    await expect(service.setThreadExecutionProject(cloud.id, backgroundThread.id)).rejects.toThrow(
      "active work",
    );
    expect(() => process.kill(cloudPid, 0)).not.toThrow();
    expect(service.reserveHarnessUpdate("codex")).toBeNull();
    await expect(service.switchBranch(local.id, "other")).rejects.toThrow("active work");
    await expect(service.removeProject(local.id)).rejects.toThrow("active work");
    const localDone = completed();
    await service.startThread({
      projectId: local.id,
      harness: "codex",
      prompt: "Local work",
      designIds: [],
    });
    await localDone;
    const localPids = [...new Set((await events(cwd)).map((event) => event.pid))].filter(
      (pid) => pid !== cloudPid,
    );
    expect(localPids).toHaveLength(1);
    allowed = false;
    await service.stopCloudThreads();
    expect(service.activeRunCount).toBe(0);
    expect(() => process.kill(cloudPid, 0)).toThrow();
    for (const pid of localPids) expect(() => process.kill(pid, 0)).not.toThrow();
    await expect(
      service.warmThread({ projectId: cloud.id, executionProjectId: local.id, harness: "codex" }),
    ).rejects.toThrow("Cloud access withdrawn");
    await service.removeProject(local.id);
    expect(store.projects.some((project) => project.id === local.id)).toBe(false);
    for (const pid of localPids) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await service.close();
  }
});

test("changing a workspace execution directory retires its native process and starts a fresh session", async () => {
  const { ProjectStore } = await import("../workspace/project-store");
  const { WorkspaceService } = await import("../workspace/workspace-service");
  const cwd = await mkdtemp(join(directory, "directory-switch-"));
  const cloudPath = join(cwd, "cloud");
  await mkdir(cloudPath);
  const store = new ProjectStore(join(cwd, "state"));
  await store.initialize();
  const local = (await store.open(cwd)).project;
  const cloud = (await store.open(cloudPath, "Team")).project;
  const service = new WorkspaceService(
    store,
    undefined,
    async () => executable,
    async () => {},
  );
  service.authorizeCloudProject = async () => {};
  const completed = () =>
    new Promise<import("../../shared/contracts/desktop").Thread>((resolve) => {
      const unsubscribe = service.subscribe((event) => {
        if (event.type === "thread" && event.thread.status === "completed") {
          unsubscribe();
          resolve(event.thread);
        }
      });
    });
  try {
    let done = completed();
    await service.startThread({
      projectId: cloud.id,
      harness: "codex",
      prompt: "Initial design request",
      designIds: [],
    });
    const thread = await done;
    expect(thread.sessionId).toBeDefined();
    const pid = (await events(cloudPath))[0].pid;
    await service.setThreadExecutionProject(cloud.id, thread.id, local.id);
    expect(() => process.kill(pid, 0)).toThrow();
    done = completed();
    await service.sendMessage({
      projectId: cloud.id,
      threadId: thread.id,
      text: "Continue in the repository",
    });
    expect((await done).messages[0].text).toBe("Initial design request");
    const started = await events(cwd);
    expect(started.some((event) => event.method === "thread/start")).toBe(true);
    expect(started.some((event) => event.method === "thread/resume")).toBe(false);
  } finally {
    await service.close();
  }
});

for (const harness of harnessIdSchema.options) {
  test(`${harness} protects background work from idle pressure, refreshes on progress and releases after completion`, async () => {
    const cwd = await mkdtemp(join(directory, `${harness}-background-`));
    const sessions = new HarnessSessions({ idleLimit: 1, idleMs: 150, backgroundSilentMs: 200 });
    const context = { projectId: "project", harness, executable, cwd };
    const updates: HarnessUpdate[] = [];
    try {
      await sessions.start("background", {
        ...context,
        prompt: "background",
        onUpdate: (update) => updates.push(update),
      }).done;
      const pid = (await events(cwd))[0].pid;
      const previous = updates.length;
      await sessions.start("other", { ...context, prompt: "other", onUpdate() {} }).done;
      await new Promise((resolve) => setTimeout(resolve, 275));
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(updates).toHaveLength(previous);
      await sessions.start("background", { ...context, prompt: "continue", onUpdate() {} }).done;
      expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(2);
      await expect(
        sessions.start("background", { ...context, prompt: "fail-turn", onUpdate() {} }).done,
      ).rejects.toThrow("Turn failed");
      expect(() => process.kill(pid, 0)).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 550));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await sessions.clear();
    }
  });

  test(`${harness} releases silent background work and shutdown overrides retention`, async () => {
    const cwd = await mkdtemp(join(directory, `${harness}-silent-`));
    const sessions = new HarnessSessions({ idleLimit: 1, idleMs: 20, backgroundSilentMs: 200 });
    const context = { projectId: "project", harness, executable, cwd };
    try {
      await sessions.start("thread", { ...context, prompt: "background silent", onUpdate() {} })
        .done;
      const pid = (await events(cwd))[0].pid;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(() => process.kill(pid, 0)).toThrow();
      await sessions.start("foreign", {
        ...context,
        prompt: "foreign background silent",
        onUpdate() {},
      }).done;
      const foreignPids = new Set((await events(cwd)).map((event) => event.pid));
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const foreign of foreignPids) expect(() => process.kill(foreign, 0)).toThrow();
      await sessions.start("thread", { ...context, prompt: "background silent", onUpdate() {} })
        .done;
      const replacements = new Set((await events(cwd)).map((event) => event.pid));
      expect(replacements.size).toBe(3);
      await sessions.clear();
      for (const replacement of replacements) expect(() => process.kill(replacement, 0)).toThrow();
    } finally {
      await sessions.clear();
    }
  });
}

test("background work survives idle invalidation and refuses incompatible settings until it finishes", async () => {
  const cwd = await mkdtemp(join(directory, "background-invalidation-"));
  const sessions = new HarnessSessions({ idleLimit: 1, idleMs: 100, backgroundSilentMs: 1000 });
  const context = { projectId: "project", harness: "codex" as const, executable, cwd };
  try {
    await sessions.start("thread", { ...context, prompt: "background agent", onUpdate() {} }).done;
    const pid = (await events(cwd))[0].pid;
    await expect(
      sessions.start("thread", {
        ...context,
        settings: { model: "different" },
        prompt: "continue",
        onUpdate() {},
      }).done,
    ).rejects.toThrow("Wait for background work");
    await sessions.clear({ idleOnly: true });
    expect(() => process.kill(pid, 0)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await sessions.clear();
  }
});

for (const harness of harnessIdSchema.options) {
  test(`${harness} retains one connection across turns and interrupt, with isolated turn callbacks`, async () => {
    const cwd = await mkdtemp(join(directory, `${harness}-`));
    const session = new HarnessSession({ harness, executable, cwd });
    try {
      await session.ready;
      const first: HarnessUpdate[] = [];
      await session.start({ prompt: "first", onUpdate: (update) => first.push(update) }).done;
      const firstCount = first.length;
      const started = Promise.withResolvers<void>();
      const stopped = session.start({
        prompt: "hold",
        onUpdate: (update) => {
          if (update.type === "started") started.resolve();
        },
      });
      await started.promise;
      stopped.stop();
      await stopped.done;
      stopped.stop();
      const last: HarnessUpdate[] = [];
      await session.start({ prompt: "last", onUpdate: (update) => last.push(update) }).done;
      expect(first).toHaveLength(firstCount);
      expect(last.filter((update) => update.type === "started")).toHaveLength(1);
      expect(last.some((update) => update.type === "message" && update.text === "OK")).toBe(true);
      const recorded = await events(cwd);
      expect(new Set(recorded.map((event) => event.pid)).size).toBe(1);
      expect(recorded.filter((event) => event.method === "initialize")).toHaveLength(1);
      expect(
        recorded.filter(
          (event) =>
            event.method === "turn/start" ||
            event.method === "session/prompt" ||
            event.type === "user",
        ),
      ).toHaveLength(3);
    } finally {
      session.close();
      await session.done;
    }
  });
  test(`${harness} rejects stale approvals after cancellation and accepts fresh approvals on the next turn`, async () => {
    const cwd = await mkdtemp(join(directory, `${harness}-approval-`));
    const session = new HarnessSession({ harness, executable, cwd });
    try {
      const pending = Promise.withResolvers<string>();
      const first = session.start({
        prompt: "approve",
        onUpdate: (update) => {
          if (update.type === "approval") pending.resolve(update.request.id);
        },
      });
      const id = await pending.promise;
      first.stop();
      await first.done;
      expect(first.respondToApproval?.(id, "allow")).toBe(false);
      const nextApproval = Promise.withResolvers<string>();
      const next = session.start({
        prompt: "approve",
        onUpdate: (update) => {
          if (update.type === "approval") nextApproval.resolve(update.request.id);
        },
      });
      const nextId = await nextApproval.promise;
      expect(nextId).not.toBe(id);
      expect(next.respondToApproval?.(id, "allow")).toBe(false);
      expect(next.respondToApproval?.(nextId, "deny")).toBe(true);
      await next.done;
    } finally {
      session.close();
      await session.done;
    }
  });
}

test("an unresponsive interrupt closes the connection before a later turn can use it", async () => {
  const cwd = await mkdtemp(join(directory, "stubborn-"));
  const session = new HarnessSession({ harness: "codex", executable, cwd });
  const started = Promise.withResolvers<void>();
  try {
    const turn = session.start({
      prompt: "stubborn",
      onUpdate: (update) => {
        if (update.type === "started") started.resolve();
      },
    });
    await started.promise;
    turn.stop();
    await turn.done;
    await session.done;
    expect(session.available).toBe(false);
    expect(() => session.start({ prompt: "next", onUpdate() {} })).toThrow("unavailable");
  } finally {
    session.close();
    await session.done;
  }
});

test("idle expiry, settings changes and crashes recreate connections without replaying a prompt", async () => {
  const cwd = await mkdtemp(join(directory, "recovery-"));
  const sessions = new HarnessSessions({ idleLimit: 2, idleMs: 25 });
  const context = { projectId: "project", harness: "codex" as const, executable, cwd };
  const send = (prompt: string, model?: string) =>
    sessions.start("thread", { ...context, settings: { model }, prompt, onUpdate() {} }).done;
  try {
    await send("first");
    await send("model change", "other");
    expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(send("crash", "other")).rejects.toThrow();
    await send("recover", "other");
    const recorded = await events(cwd);
    expect(new Set(recorded.map((event) => event.pid)).size).toBe(4);
    expect(recorded.filter((event) => event.method === "turn/start")).toHaveLength(4);
  } finally {
    await sessions.clear();
  }
});

test("idle cleanup preserves active turns and discarded handles cannot interrupt their successor", async () => {
  const cwd = await mkdtemp(join(directory, "active-"));
  const sessions = new HarnessSessions({ idleLimit: 1, idleMs: 25 });
  const context = { projectId: "project", harness: "codex" as const, executable, cwd };
  try {
    const started = Promise.withResolvers<void>();
    const first = sessions.start("thread", {
      ...context,
      prompt: "hold",
      onUpdate: (update) => {
        if (update.type === "started") started.resolve();
      },
    });
    await started.promise;
    await sessions.clear({ idleOnly: true });
    expect(first.deliveryState).toBe("accepted");
    first.stop();
    await first.done;
    const nextStarted = Promise.withResolvers<void>();
    const next = sessions.start("thread", {
      ...context,
      prompt: "hold",
      onUpdate: (update) => {
        if (update.type === "started") nextStarted.resolve();
      },
    });
    await nextStarted.promise;
    first.stop();
    expect(next.deliveryState).toBe("accepted");
    next.stop();
    await next.done;
    expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(2);
  } finally {
    await sessions.clear();
  }
});

test("interrupt waits for the native turn to start after its early acceptance acknowledgement", async () => {
  const cwd = await mkdtemp(join(directory, "early-stop-"));
  const session = new HarnessSession({ harness: "codex", executable, cwd });
  try {
    const run = session.start({
      prompt: "early-stop hold",
      onUpdate: (update) => {
        if (update.type === "started") run.stop();
      },
    });
    await run.done;
    expect(session.available).toBe(true);
    await session.start({ prompt: "continue", onUpdate() {} }).done;
  } finally {
    session.close();
    await session.done;
  }
});

test.each(["/", "$"])(
  "OpenCode preserves selected model, %s command and image inputs and reports turn usage",
  async (prefix) => {
    const cwd = await mkdtemp(join(directory, "inputs-"));
    const session = new HarnessSession({
      harness: "opencode",
      executable,
      cwd,
      settings: { model: "fixture/model" },
    });
    const updates: HarnessUpdate[] = [];
    try {
      await session.start({
        prompt: "Project context priced /review file",
        skill: {
          invocation: { kind: "command", name: "review", description: "Review" },
          prompt: `${prefix}review file`,
          context: "Project context priced",
        },
        images: [{ path: join(cwd, "image.png"), mimeType: "image/png", data: "aW1hZ2U=" }],
        onUpdate: (update) => updates.push(update),
      }).done;
      const recorded = await events(cwd);
      expect(
        recorded.find((event) => event.method === "session/set_config_option")?.value.params,
      ).toMatchObject({ configId: "model", value: "fixture/model" });
      expect(
        recorded.find((event) => event.method === "session/prompt")?.value.params,
      ).toMatchObject({
        prompt: [
          { type: "text", text: "/review file\n\nProject context priced" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      });
      expect(updates.find((update) => update.type === "usage")).toMatchObject({
        cumulative: false,
        usage: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 8, costUSD: 0.25 },
      });
      const followUp: HarnessUpdate[] = [];
      await session.start({
        prompt: "priced follow-up",
        onUpdate: (update) => followUp.push(update),
      }).done;
      expect(followUp.find((update) => update.type === "usage")).toMatchObject({
        cumulative: false,
        usage: { costUSD: 0.25 },
      });
      const next: HarnessUpdate[] = [];
      await session.start({ prompt: "Continue", onUpdate: (update) => next.push(update) }).done;
      expect(next.find((update) => update.type === "usage")).toMatchObject({
        usage: { costUSD: undefined },
      });
    } finally {
      session.close();
      await session.done;
    }
  },
);

for (const replayCost of [false, true]) {
  test(`OpenCode resumed turn cost uses ${replayCost ? "replayed" : "unknown"} session totals`, async () => {
    const cwd = await mkdtemp(join(directory, "resume-cost-"));
    if (replayCost) await writeFile(join(cwd, "replay-cost"), "");
    const session = new HarnessSession({
      harness: "opencode",
      executable,
      cwd,
      sessionId: "ses_fixture",
    });
    try {
      for (const expectedCost of [replayCost ? 0.25 : undefined, 0]) {
        const updates: HarnessUpdate[] = [];
        await session.start({
          prompt: "priced follow-up",
          onUpdate: (update) => updates.push(update),
        }).done;
        expect(updates.find((update) => update.type === "usage")).toMatchObject({
          cumulative: false,
          usage: { costUSD: expectedCost },
        });
      }
    } finally {
      session.close();
      await session.done;
    }
  });
}

test("OpenCode ignores replayed history while loading an opaque native session identifier", async () => {
  const cwd = await mkdtemp(join(directory, "resume-"));
  const session = new HarnessSession({
    harness: "opencode",
    executable,
    cwd,
    sessionId: "ses_fixture",
  });
  const updates: HarnessUpdate[] = [];
  try {
    await session.start({ prompt: "Continue", onUpdate: (update) => updates.push(update) }).done;
    expect(session.sessionId).toBe("ses_fixture");
    expect(nativeSessionIdSchema.safeParse("--permission-mode").success).toBe(false);
    expect(updates.filter((update) => update.type === "message")).toEqual([
      { type: "message", id: expect.any(String), text: "OK", append: true },
    ]);
  } finally {
    session.close();
    await session.done;
  }
});

test("concurrent capability requests share initialization and close their temporary connection", async () => {
  const cwd = await mkdtemp(join(directory, "metadata-"));
  const { withHarnessConnection } = await import("./harness-connection");
  const input = { harness: "codex" as const, executable, cwd };
  await Promise.all(
    [0, 1].map(() =>
      withHarnessConnection(input, async (request) => {
        await request("initialize");
        await request("thread/start");
      }),
    ),
  );
  const recorded = await events(cwd);
  expect(recorded.filter((event) => event.method === "initialize")).toHaveLength(1);
  expect(new Set(recorded.map((event) => event.pid)).size).toBe(1);
  const pid = recorded[0].pid;
  expect(() => process.kill(pid, 0)).toThrow();
});

test("OpenCode replays command discovery to late subscribers and reuses legacy discovery sessions", async () => {
  const { withHarnessConnection } = await import("./harness-connection");
  const { HarnessSkills } = await import("./harness-skills");
  const cwd = await mkdtemp(join(directory, "discovery-replay-"));
  const input = { harness: "opencode" as const, executable, cwd };
  const announced = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const inspection = withHarnessConnection(input, async (request) => {
    await request("initialize");
    await request("session/new", { cwd, mcpServers: [] });
    announced.resolve();
    await release.promise;
  });
  try {
    await announced.promise;
    const catalog = new HarnessSkills(async () => executable);
    expect((await catalog.list(input)).skills.map((skill) => skill.name)).toEqual(["review"]);
    release.resolve();
    await inspection;
    expect(
      (await catalog.list({ ...input, refresh: true })).skills.map((skill) => skill.name),
    ).toEqual(["review"]);
    const recorded = await events(cwd);
    expect(recorded.filter((event) => event.method === "session/new")).toHaveLength(1);
    expect(recorded.filter((event) => event.method === "session/load")).toHaveLength(1);
    expect(
      recorded.some(
        (event) => event.method === "session/prompt" || event.method === "session/delete",
      ),
    ).toBe(false);
    for (const { pid } of recorded) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    release.resolve();
    await inspection;
  }
});

test("OpenCode deletes shared temporary discovery sessions after the final reader, including failed readers", async () => {
  const { withHarnessConnection } = await import("./harness-connection");
  const { inspectHarness } = await import("./harness-details");
  const { HarnessSkills } = await import("./harness-skills");
  const cwd = await mkdtemp(join(directory, "discovery-cleanup-"));
  await writeFile(join(cwd, "delete-capability"), "");
  const input = { harness: "opencode" as const, executable, cwd };
  const [details, catalog] = await Promise.all([
    inspectHarness(executable, "opencode", cwd),
    new HarnessSkills(async () => executable).list(input),
  ]);
  expect(details.models.map((model) => model.id)).toEqual(["fixture/model"]);
  expect(catalog.skills.map((skill) => skill.name)).toEqual(["review"]);
  await expect(
    withHarnessConnection(input, async (request) => {
      await request("initialize");
      await request("session/new", { cwd, mcpServers: [] });
      throw new Error("Reader failed");
    }),
  ).rejects.toThrow("Reader failed");
  await rm(join(cwd, "delete-capability"));
  await writeFile(join(cwd, "no-load-capability"), "");
  await expect(new HarnessSkills(async () => executable).list(input)).rejects.toThrow(
    "Update OpenCode",
  );
  const recorded = await events(cwd);
  expect(recorded.filter((event) => event.method === "session/new")).toHaveLength(2);
  expect(recorded.filter((event) => event.method === "session/delete")).toHaveLength(2);
  for (const { pid } of recorded) expect(() => process.kill(pid, 0)).toThrow();
});

for (const harness of harnessIdSchema.options) {
  test(`${harness} shares the idle budget with composer preparation and prepares evicted conversations for send`, async () => {
    const cwd = await mkdtemp(join(directory, `${harness}-reopen-`));
    const sessions = new HarnessSessions({ idleLimit: 1, idleMs: 60_000 });
    const context = { projectId: "project", harness, executable, cwd };
    let sessionId: string | undefined;
    try {
      await sessions.prepare({ kind: "composer", id: "project", context });
      if (harness === "opencode")
        expect((await events(cwd)).some((event) => event.method === "session/new")).toBe(false);
      expect(
        (await events(cwd)).filter(
          (event) =>
            event.method === "turn/start" ||
            event.method === "session/prompt" ||
            event.type === "user",
        ),
      ).toHaveLength(0);
      await sessions.start("first", {
        ...context,
        prompt: "first",
        onUpdate(update) {
          if (update.type === "session") sessionId = update.id;
        },
      }).done;
      expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(1);
      await sessions.start("other", { ...context, prompt: "other", onUpdate() {} }).done;
      expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(2);
      await sessions.prepare({ kind: "thread", id: "first", context: { ...context, sessionId } });
      const prepared = await events(cwd);
      const prompts = prepared.filter(
        (event) =>
          event.method === "turn/start" ||
          event.method === "session/prompt" ||
          event.type === "user",
      );
      expect(prompts).toHaveLength(2);
      expect(new Set(prepared.map((event) => event.pid)).size).toBe(3);
      await sessions.start("first", { ...context, sessionId, prompt: "continue", onUpdate() {} })
        .done;
      expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(3);
    } finally {
      await sessions.clear();
    }
  });
}

test("preparing an existing conversation uses its private native identity and stored permissions", async () => {
  const { ProjectStore } = await import("../workspace/project-store");
  const { WorkspaceService } = await import("../workspace/workspace-service");
  const cwd = await mkdtemp(join(directory, "authority-"));
  const store = new ProjectStore(join(cwd, "state"));
  await store.initialize();
  const { project } = await store.open(cwd);
  const service = new WorkspaceService(
    store,
    undefined,
    async () => executable,
    async () => {},
  );
  const completed = () =>
    new Promise<Awaited<ReturnType<typeof service.readThread>>>((resolve) => {
      const unsubscribe = service.subscribe((event) => {
        if (event.type === "thread" && event.thread.status === "completed") {
          unsubscribe();
          resolve(event.thread);
        }
      });
    });
  try {
    const initialDone = completed();
    await service.startThread({
      projectId: project.id,
      harness: "codex",
      prompt: "Initial",
      designIds: [],
      settings: { permissionMode: "read-only" },
    });
    const thread = await initialDone;
    const recover = await service.prepareUpdate();
    recover();
    const previous = (await events(cwd)).length;
    await service.warmThread({
      projectId: project.id,
      threadId: thread.id,
      harness: "opencode",
      settings: { permissionMode: "auto" },
    });
    const prepared = (await events(cwd)).slice(previous);
    expect(prepared.find((event) => event.method === "thread/resume")?.value.params).toMatchObject({
      threadId: thread.sessionId,
      sandbox: "read-only",
    });
    expect(prepared.some((event) => event.method === "turn/start")).toBe(false);
    const done = completed();
    await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "Continue" });
    expect((await done).messages.at(-1)?.text).toBe("OK");
    expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(2);
  } finally {
    await service.close();
  }
});

for (const [harness, code, kind] of [
  ["codex", "sandboxError", "sandbox"],
  ["claude", "error_max_budget_usd", "budget"],
] as const) {
  test(`${harness} retains failure details and categories, then recovers on the same session`, async () => {
    const cwd = await mkdtemp(join(directory, `${harness}-provider-failure-`));
    const session = new HarnessSession({ harness, executable, cwd });
    const updates: HarnessUpdate[] = [];
    const start = (prompt: string) =>
      session.start({ prompt, onUpdate: (update) => updates.push(update) }).done;
    try {
      await session.ready;
      await expect(start("provider-failure-fixture")).rejects.toMatchObject({
        kind: "policy",
        message: "This content was flagged for possible cybersecurity risk.",
      });
      await start("provider-retry-fixture");
      if (harness === "claude")
        expect(updates.at(-2)).toEqual({ type: "error-cleared", text: "Too many requests" });
      await expect(start(`structured-failure-fixture ${code}`)).rejects.toMatchObject({ kind });
      await start("continue");
      expect(session.idle).toBe(true);
      expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(1);
    } finally {
      session.close();
      await session.done;
    }
  });
}

for (const harness of harnessIdSchema.options) {
  test(`${harness} reused sessions receive fresh browser configuration without exposing the token`, async () => {
    const cwd = await mkdtemp(join(directory, "browser-turns-"));
    const browser = new BrowserService(async () => {});
    const bridge = new BrowserAgentBridge(browser);
    const sessions = new HarnessSessions();
    const scope = { projectId: randomUUID(), threadId: randomUUID() };
    const configurations: string[] = [];
    try {
      for (let turn = 0; turn < 2; turn++) {
        const tool = await bridge.session(scope);
        configurations.push(tool.configuration);
        try {
          await sessions.start(scope.threadId, {
            projectId: scope.projectId,
            harness,
            executable,
            cwd,
            prompt: tool.instructions + "\n\nCheck this page.",
            onUpdate() {},
          }).done;
        } finally {
          tool.close();
        }
      }
      const recorded = await events(cwd);
      expect(new Set(recorded.map((event) => event.pid)).size).toBe(1);
      expect(configurations[0]).not.toBe(configurations[1]);
      const serialized = JSON.stringify(recorded);
      for (const configuration of configurations)
        expect(serialized).toContain(basename(dirname(configuration)));
      expect(serialized).not.toMatch(/Bearer [a-f0-9]{64}/);
    } finally {
      await sessions.clear();
      await bridge.close();
      await browser.close();
    }
  });
}

for (const harness of harnessIdSchema.options) {
  test(`${harness} applies changed access to the active request and clears stale approvals and background work`, async () => {
    const { ProjectStore } = await import("../workspace/project-store");
    const { WorkspaceService } = await import("../workspace/workspace-service");
    const cwd = await mkdtemp(join(directory, `${harness}-live-access-`));
    const store = new ProjectStore(join(cwd, "private"));
    await store.initialize();
    const { project } = await store.open(cwd);
    const service = new WorkspaceService(
      store,
      undefined,
      async () => executable,
      async () => {},
    );
    try {
      const thread = await service.startThread({
        projectId: project.id,
        harness,
        prompt: "approve background silent",
        designIds: [],
      });
      let original = await service.readThread(project.id, thread.id);
      for (let attempt = 0; !original.pendingApprovals?.length && attempt < 100; attempt++) {
        await Bun.sleep(5);
        original = await service.readThread(project.id, thread.id);
      }
      expect(original.pendingApprovals).toHaveLength(1);
      expect(original.settings?.permissionMode).toBe("default");
      const approvalId = original.pendingApprovals![0].id;
      const pid = (await events(cwd))[0].pid;
      await service.setThreadSettings(project.id, thread.id, { permissionMode: "auto" });
      let after = await service.readThread(project.id, thread.id);
      for (let attempt = 0; after.status === "running" && attempt < 100; attempt++) {
        await Bun.sleep(5);
        after = await service.readThread(project.id, thread.id);
      }
      expect(after.status).toBe("completed");
      expect(after.settings?.permissionMode).toBe("auto");
      expect(after.pendingApprovals).toBeUndefined();
      expect(after.sessionId).toBe(original.sessionId);
      expect(
        after.messages.filter((message) => message.role === "user").map((message) => message.id),
      ).toEqual([original.messages[0].id]);
      expect(after.messages[0].turn?.startedAt).toBe(original.messages[0].turn?.startedAt);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(new Set((await events(cwd)).map((event) => event.pid)).size).toBe(2);
      await expect(
        service.respondToApproval(project.id, thread.id, approvalId, "allow"),
      ).rejects.toThrow("no longer");
      if (harness === "codex") {
        const resume = (await events(cwd)).find((event) => event.method === "thread/resume");
        expect(resume?.value.params).toMatchObject({
          sandbox: "danger-full-access",
          approvalPolicy: "never",
        });
      }
      // The old background work must not block a later model change either.
      await service.setThreadSettings(project.id, thread.id, {
        permissionMode: "auto",
        model: "another-model",
      });
    } finally {
      await service.close();
    }
  });

  test(`${harness} Stop releases retained background work so settings and follow-ups remain usable`, async () => {
    const { ProjectStore } = await import("../workspace/project-store");
    const { WorkspaceService } = await import("../workspace/workspace-service");
    const cwd = await mkdtemp(join(directory, `${harness}-stop-background-`));
    const store = new ProjectStore(join(cwd, "private"));
    await store.initialize();
    const { project } = await store.open(cwd);
    const service = new WorkspaceService(
      store,
      undefined,
      async () => executable,
      async () => {},
    );
    try {
      const thread = await service.startThread({
        projectId: project.id,
        harness,
        prompt: "background silent",
        designIds: [],
      });
      for (
        let attempt = 0;
        (await service.readThread(project.id, thread.id)).status === "running" && attempt < 100;
        attempt++
      )
        await Bun.sleep(5);
      const original = await service.readThread(project.id, thread.id);
      expect(original.status).toBe("completed");
      const pid = (await events(cwd))[0].pid;
      await service.stopThread(project.id, thread.id);
      expect(() => process.kill(pid, 0)).toThrow();
      await service.setThreadSettings(project.id, thread.id, {
        permissionMode: "default",
        model: "another-model",
      });
      await service.sendMessage({ projectId: project.id, threadId: thread.id, text: "Continue" });
      for (
        let attempt = 0;
        (await service.readThread(project.id, thread.id)).status === "running" && attempt < 100;
        attempt++
      )
        await Bun.sleep(5);
      const after = await service.readThread(project.id, thread.id);
      expect(after.status).toBe("completed");
      expect(after.sessionId).toBe(original.sessionId);
      expect(after.messages.filter((message) => message.role === "user")).toHaveLength(2);
    } finally {
      await service.close();
    }
  });
}
