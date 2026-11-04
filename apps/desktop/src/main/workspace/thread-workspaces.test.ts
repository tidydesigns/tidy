import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { git } from "../repository/repository-context";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";
import { createWorkspaceRequests } from "../ipc/workspace-requests";
import type { Thread } from "../../shared/contracts/desktop";
import type { startHarness } from "../harnesses/harnesses";
import { HarnessSkills, type SkillAdapter } from "../harnesses/harness-skills";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(commit = true, skills?: HarnessSkills) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tidy-thread-workspaces-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "project");
  await mkdir(root);
  await git(root, ["init", "-b", "main"]);
  if (commit) {
    await mkdir(join(root, "app"));
    await writeFile(join(root, "app", "file.txt"), "committed");
    await git(root, ["add", "."]);
    await git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "Initial",
    ]);
  }
  const state = join(directory, "state");
  const store = new ProjectStore(state);
  await store.initialize();
  const project = (await store.open(root)).project;
  const runs: Array<{ input: Parameters<typeof startHarness>[0]; complete(): void }> = [];
  function serviceFor(store: ProjectStore) {
    const service = new WorkspaceService(
      store,
      (input) => {
        const done = Promise.withResolvers<void>();
        runs.push({ input, complete: () => done.resolve() });
        return { done: done.promise, stop: () => done.resolve() };
      },
      async () => "/fixture/harness",
      async () => {},
      skills,
    );
    cleanups.push(() => service.close());
    return service;
  }
  const service = serviceFor(store);
  const start = (threadMode?: "local" | "worktree") =>
    service.startThread({
      projectId: project.id,
      harness: "codex",
      prompt: "Implement a change",
      designIds: [],
      threadMode,
    });
  const handlers = createWorkspaceRequests(service, {
    chooseProject: async () => null,
    chooseDesign: async () => null,
    openExternal: async () => {},
    showItemInFolder() {},
  });
  const finish = (thread: Thread, run = runs[runs.length - 1]) =>
    new Promise<void>((resolve) => {
      const unsubscribe = service.subscribe((event) => {
        if (
          event.type === "thread" &&
          event.thread.id === thread.id &&
          event.thread.status !== "running"
        ) {
          unsubscribe();
          resolve();
        }
      });
      run.complete();
    });
  return {
    directory,
    state,
    root,
    store,
    project,
    runs,
    service,
    serviceFor,
    start,
    handlers,
    finish,
  };
}

test("new Git threads run concurrently in separate worktrees without copying dirty files or secrets", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "app", "file.txt"), "unfinished original");
  await writeFile(join(f.root, ".env.local"), "PRIVATE_TEST_VALUE=local-only");
  const [a, b] = await Promise.all([f.start(), f.start()]);
  expect(a.worktree?.path).not.toBe(b.worktree?.path);
  expect(a.worktree?.branch).toStartWith("feat/tidy-");
  expect(await git(f.root, ["branch", "--show-current"])).toBe("main");
  for (const thread of [a, b]) {
    expect(f.runs.some((run) => run.input.cwd === thread.worktree?.path)).toBe(true);
    expect(await readFile(join(thread.worktree!.path, "app", "file.txt"), "utf8")).toBe(
      "committed",
    );
    expect(await Bun.file(join(thread.worktree!.path, ".env.local")).exists()).toBe(false);
    expect(
      (await f.store.snapshot(f.project.id)).threads.find((item) => item.id === thread.id)
        ?.worktree,
    ).toEqual(thread.worktree);
  }
  await writeFile(join(a.worktree!.path, "app", "file.txt"), "thread A");
  expect(await readFile(join(b.worktree!.path, "app", "file.txt"), "utf8")).toBe("committed");
  expect(await readFile(join(f.root, "app", "file.txt"), "utf8")).toBe("unfinished original");
  const file = await f.handlers.invoke(
    "repository-file",
    { projectId: f.project.id, threadId: a.id, path: "app/file.txt" },
    undefined,
  );
  expect(JSON.stringify(file)).toContain("thread A");
  expect(f.runs[0].input.prompt).toContain("do not create another worktree");
  expect(f.runs[0].input.additionalDirectories).toContain(join(f.root, ".tidy", "designs"));
});

test("continuation and restart reuse the original worktree and preserve unfinished edits", async () => {
  const f = await fixture();
  const thread = await f.start();
  await f.finish(thread);
  await writeFile(join(thread.worktree!.path, "app", "file.txt"), "retained");
  await f.service.sendMessage({ projectId: f.project.id, threadId: thread.id, text: "Continue" });
  expect(f.runs[1].input.cwd).toBe(thread.worktree!.path);
  await f.service.stopThread(f.project.id, thread.id);
  await f.service.close();
  const store = new ProjectStore(f.state);
  await store.initialize();
  const service = f.serviceFor(store);
  const restored = await service.readThread(f.project.id, thread.id);
  expect(restored.worktree).toEqual(thread.worktree);
  await service.sendMessage({
    projectId: f.project.id,
    threadId: thread.id,
    text: "Continue after restart",
  });
  expect(f.runs[2].input.cwd).toBe(thread.worktree!.path);
  expect(await readFile(join(thread.worktree!.path, "app", "file.txt"), "utf8")).toBe("retained");
});

test("current folder is remembered per project, rejects concurrent checkout runs, and allows a worktree override", async () => {
  const f = await fixture();
  await f.store.setThreadMode(f.project.id, "local");
  const first = await f.start();
  expect(first.worktree).toBeUndefined();
  expect(f.runs[0].input.cwd).toBe(f.root);
  const results = await Promise.allSettled([f.start("local"), f.start("worktree")]);
  expect(results[0].status).toBe("rejected");
  expect(results[1].status).toBe("fulfilled");
  await f.finish(first, f.runs[0]);
  expect((await f.start()).worktree).toBeUndefined();
  const reopened = await f.store.register(f.root);
  expect(reopened.threadMode).toBe("local");
  const restored = new ProjectStore(f.state);
  await restored.initialize();
  expect(restored.project(f.project.id).threadMode).toBe("local");
});

test("simultaneous current-folder starts admit one run even through separate project subdirectories", async () => {
  const f = await fixture();
  const subproject = (await f.store.open(join(f.root, "app"))).project;
  const results = await Promise.allSettled([
    f.start("local"),
    f.service.startThread({
      projectId: subproject.id,
      harness: "codex",
      prompt: "Other",
      designIds: [],
      threadMode: "local",
    }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(f.runs).toHaveLength(1);
});

test("worktree paths cannot be injected or redirected by portable thread JSON", async () => {
  const f = await fixture();
  const thread = await f.start();
  await f.finish(thread);
  const path = await f.store.storagePath(f.project.id, "threads", thread.id);
  const stored = JSON.parse(await readFile(path, "utf8"));
  stored.worktree.path = f.root;
  await writeFile(path, JSON.stringify(stored));
  const restarted = new ProjectStore(f.state);
  await restarted.initialize();
  await expect(restarted.readThread(f.project.id, thread.id)).rejects.toThrow("worktree changed");
  const forged = { ...stored, id: randomUUID() };
  await writeFile(
    await f.store.storagePath(f.project.id, "threads", forged.id),
    JSON.stringify(forged),
  );
  await expect(f.store.readThread(f.project.id, forged.id)).rejects.toThrow("worktree changed");
});

test("missing or replaced worktrees never fall back to editing the original checkout", async () => {
  const f = await fixture();
  const thread = await f.start();
  await f.finish(thread);
  await rm(thread.worktree!.root, { recursive: true });
  await expect(
    f.service.sendMessage({ projectId: f.project.id, threadId: thread.id, text: "Continue" }),
  ).rejects.toThrow();
  await symlink(f.root, thread.worktree!.root);
  await expect(
    f.service.sendMessage({ projectId: f.project.id, threadId: thread.id, text: "Continue" }),
  ).rejects.toThrow("moved");
  expect(f.runs).toHaveLength(1);
});

test("subdirectory projects keep their relative working directory inside the worktree", async () => {
  const f = await fixture();
  const project = (await f.store.open(join(f.root, "app"))).project;
  const thread = await f.service.startThread({
    projectId: project.id,
    harness: "codex",
    prompt: "Subdirectory",
    designIds: [],
  });
  expect(thread.worktree!.path).toBe(join(thread.worktree!.root, "app"));
  expect(f.runs[0].input.cwd).toBe(thread.worktree!.path);
});

test("warming a new composer does not create a worktree; unborn repositories explain the current-folder option", async () => {
  const f = await fixture(false);
  await f.service.warmThread({ projectId: f.project.id, harness: "codex" });
  expect((await git(f.root, ["worktree", "list", "--porcelain"])).match(/worktree /g)).toHaveLength(
    1,
  );
  await expect(f.start()).rejects.toThrow("initial commit");
  expect((await f.start("local")).worktree).toBeUndefined();
});

test("workspace code threads isolate code while design references remain canonical", async () => {
  const f = await fixture();
  const cloudPath = join(f.directory, "workspace");
  await mkdir(cloudPath);
  const cloud = (await f.store.open(cloudPath, "Workspace")).project;
  f.service.authorizeCloudProject = async () => {};
  const design = await f.store.createDesign(cloud.id);
  const thread = await f.service.startThread({
    projectId: cloud.id,
    executionProjectId: f.project.id,
    harness: "codex",
    prompt: "Build this",
    designIds: [design.id],
  });
  expect(thread.worktree).toBeDefined();
  expect(f.runs[0].input.prompt).toContain(design.path);
  expect(f.runs[0].input.additionalDirectories).toContain(join(cloudPath, ".tidy", "designs"));
  await expect(
    f.service.setThreadExecutionProject(cloud.id, thread.id, undefined, true),
  ).rejects.toThrow("new thread");
});

test("legacy current-folder threads keep their checkout even after the default changes", async () => {
  const f = await fixture();
  const thread = await f.start("local");
  await f.finish(thread);
  await f.store.setThreadMode(f.project.id, "worktree");
  await f.service.sendMessage({
    projectId: f.project.id,
    threadId: thread.id,
    text: "Continue existing work",
  });
  expect(f.runs[1].input.cwd).toBe(f.root);
  expect((await f.service.readThread(f.project.id, thread.id)).worktree).toBeUndefined();
});

test("worktree creation skips checkout hooks and rejects uncommitted project subdirectories", async () => {
  const f = await fixture();
  const hooks = join(f.directory, "hooks");
  await mkdir(hooks);
  const marker = join(f.directory, "hook-ran");
  await writeFile(join(hooks, "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  await git(f.root, ["config", "core.hooksPath", hooks]);
  expect((await f.start()).worktree).toBeDefined();
  expect(await Bun.file(marker).exists()).toBe(false);
  await mkdir(join(f.root, "uncommitted"));
  const nested = (await f.store.open(join(f.root, "uncommitted"))).project;
  await expect(
    f.service.startThread({
      projectId: nested.id,
      harness: "codex",
      prompt: "Build",
      designIds: [],
    }),
  ).rejects.toThrow("no committed files");
});

for (const operation of ["repository-directory", "repository-file"] as const) {
  test(`${operation} publishes cloud-owned worktree changes to the execution project's panel`, async () => {
    const f = await fixture();
    const cloudPath = join(f.directory, "cloud-observer");
    await mkdir(cloudPath);
    const cloud = (await f.store.open(cloudPath, "Workspace")).project;
    f.service.authorizeCloudProject = async () => {};
    const thread = await f.service.startThread({
      projectId: cloud.id,
      executionProjectId: f.project.id,
      harness: "codex",
      prompt: "Build",
      designIds: [],
    });
    const changed = Promise.withResolvers<string>();
    const unsubscribe = f.service.subscribe((event) => {
      if (event.type === "repository-change") changed.resolve(event.projectId);
    });
    const timer = setTimeout(
      () => changed.reject(new Error("Repository notification was not delivered.")),
      2000,
    );
    try {
      await f.handlers.invoke(
        operation,
        {
          projectId: cloud.id,
          threadId: thread.id,
          path: operation === "repository-directory" ? "app" : "app/file.txt",
        },
        undefined,
      );
      await writeFile(join(thread.worktree!.path, "app", "file.txt"), "Updated by the agent");
      expect(await changed.promise).toBe(f.project.id);
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  });
}

test("repeated repository browsing reuses an authorized summary instead of parsing the transcript", async () => {
  const f = await fixture();
  const thread = await f.start();
  await f.finish(thread);
  expect(await f.service.repositoryPath(f.project.id, thread.id)).toBe(thread.worktree!.path);
  const original = f.store.readThread;
  f.store.readThread = async () => {
    throw new Error("Repository browsing must not decode a transcript.");
  };
  try {
    expect(await f.service.repositoryPath(f.project.id, thread.id)).toBe(thread.worktree!.path);
    expect(await f.service.repositoryPath(f.project.id, thread.id)).toBe(thread.worktree!.path);
  } finally {
    f.store.readThread = original;
  }
});

test("repository scopes reject a live thread belonging to another project", async () => {
  const f = await fixture();
  const thread = await f.start();
  const otherPath = join(f.directory, "other");
  await mkdir(otherPath);
  const other = (await f.store.open(otherPath)).project;
  await expect(f.service.repositoryPath(other.id, thread.id)).rejects.toThrow("another project");
});

test("a skill selected before worktree creation keeps its authorized project catalog identity", async () => {
  const adapter: SkillAdapter = {
    discover: async ({ cwd }) => [
      {
        kind: "file",
        name: "review",
        description: "Review a change",
        path: join(cwd, "review-skill.md"),
      },
    ],
  };
  const skills = new HarnessSkills(async () => "/fixture/harness", {
    codex: adapter,
    claude: adapter,
    opencode: adapter,
  });
  const f = await fixture(true, skills);
  await writeFile(join(f.root, "review-skill.md"), "Review the requested change.");
  const catalog = await skills.list({ harness: "codex", cwd: f.root });
  const thread = await f.service.startThread({
    projectId: f.project.id,
    harness: "codex",
    prompt: "$review this change",
    skillId: catalog.skills[0].id,
    designIds: [],
  });
  expect(f.runs[0].input.cwd).toBe(thread.worktree!.path);
  expect(f.runs[0].input.skill?.invocation).toMatchObject({
    kind: "file",
    path: join(f.root, "review-skill.md"),
  });
});

test("Devices discovers apps from the authorized thread checkout and rejects a forged owner", async () => {
  const f = await fixture();
  const thread = await f.start();
  await f.finish(thread);
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({ name: "original-app", dependencies: { expo: "58" } }),
  );
  await writeFile(
    join(thread.worktree!.path, "package.json"),
    JSON.stringify({ name: "thread-app", dependencies: { expo: "58" } }),
  );
  const scoped = await f.service.mobile.state({ projectId: f.project.id, threadId: thread.id });
  expect(scoped.targets.map((target) => target.name)).toEqual(["thread-app"]);
  const original = await f.service.mobile.state({ projectId: f.project.id });
  expect(original.targets.map((target) => target.name)).toEqual(["original-app"]);
  const otherPath = join(f.directory, "other-mobile-project");
  await mkdir(otherPath);
  const other = (await f.store.open(otherPath)).project;
  await expect(
    f.service.mobile.state({
      projectId: other.id,
      threadId: thread.id,
      threadProjectId: f.project.id,
    }),
  ).rejects.toThrow("another project");
});

test("worktree preferences persist on the host and apply only to new threads", async () => {
  const f = await fixture();
  const first = await f.start();
  await f.finish(first);
  const initial = await f.store.worktreePreferences.read();
  expect(initial.naming).toBe("uuid");
  expect(initial.inactiveDays).toBe(0);
  expect(initial.deleteWithThread || initial.deleteMerged || initial.deleteUnchanged).toBe(false);
  await f.handlers.invoke(
    "set-worktree-preferences",
    { ...initial, naming: "prompt", branchPrefix: "fix/" },
    undefined,
  );
  const next = await f.start();
  expect(next.worktree?.branch).toBe(`fix/implement-a-change-${next.id.slice(0, 8)}`);
  expect((await f.service.readThread(f.project.id, first.id)).worktree).toEqual(first.worktree);
  const reloaded = new ProjectStore(f.state);
  await reloaded.initialize();
  expect((await reloaded.worktreePreferences.read()).branchPrefix).toBe("fix/");
  await expect(
    f.handlers.invoke("set-worktree-preferences", { ...initial, branchPrefix: "../" }, undefined),
  ).rejects.toThrow("Invalid desktop request");
});

test("inventory adopts trusted legacy worktrees and manual removal retains thread and branch", async () => {
  const f = await fixture();
  const thread = await f.start();
  let inventory = await f.service.worktreeStorage();
  expect(inventory.entries.find((entry) => entry.id === thread.id)?.busy).toBe(true);
  await expect(f.service.removeWorktree(f.project.id, thread.id)).rejects.toThrow("in use");
  await f.finish(thread);
  await f.store.processState.remove("managed-worktrees");
  inventory = await f.service.worktreeStorage();
  const entry = inventory.entries.find((entry) => entry.id === thread.id)!;
  expect(entry.bytes).toBeGreaterThan(0);
  expect(entry.busy || entry.hasChanges).toBe(false);
  await f.handlers.invoke(
    "remove-worktree",
    { projectId: f.project.id, threadId: thread.id },
    undefined,
  );
  expect(await Bun.file(join(thread.worktree!.root, "app/file.txt")).exists()).toBe(false);
  expect(await git(f.root, ["rev-parse", thread.worktree!.branch])).toBe(
    thread.worktree!.baseCommit,
  );
  expect((await f.service.readThread(f.project.id, thread.id)).messages.length).toBeGreaterThan(0);
  expect((await f.service.worktreeStorage()).entries).toHaveLength(0);
});

test("default cleanup retains everything; deleted-thread cleanup requires a private receipt", async () => {
  const f = await fixture();
  const thread = await f.start();
  await f.finish(thread);
  await f.service.cleanupWorktrees();
  expect(await Bun.file(join(thread.worktree!.root, "app/file.txt")).exists()).toBe(true);
  await rm(await f.store.storagePath(f.project.id, "threads", thread.id));
  await f.service.setWorktreePreferences({
    ...(await f.store.worktreePreferences.read()),
    deleteWithThread: true,
  });
  await f.service.cleanupWorktrees();
  expect(await Bun.file(join(thread.worktree!.root, "app/file.txt")).exists()).toBe(false);
  expect(await git(f.root, ["rev-parse", thread.worktree!.branch])).toBe(
    thread.worktree!.baseCommit,
  );
});

test("inactive cleanup skips running, recent and dirty worktrees", async () => {
  const f = await fixture();
  const old = await f.start();
  await f.finish(old);
  const dirty = await f.start();
  await f.finish(dirty);
  await writeFile(join(dirty.worktree!.root, "app/file.txt"), "keep me");
  const recent = await f.start();
  await f.finish(recent);
  const running = await f.start();
  for (const id of [old.id, dirty.id, running.id]) {
    const thread = await f.store.readThread(f.project.id, id);
    thread.updatedAt = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await f.store.writeThread(thread);
  }
  await f.service.setWorktreePreferences({
    ...(await f.store.worktreePreferences.read()),
    inactiveDays: 30,
  });
  await f.service.cleanupWorktrees();
  expect(await Bun.file(join(old.worktree!.root, "app/file.txt")).exists()).toBe(false);
  for (const thread of [dirty, recent, running])
    expect(await Bun.file(join(thread.worktree!.root, "app/file.txt")).exists()).toBe(true);
});

test("merged cleanup needs both merged PR evidence and ancestry; absent default metadata skips unchanged cleanup", async () => {
  const f = await fixture();
  const thread = await f.start();
  await f.finish(thread);
  const current = await f.store.readThread(f.project.id, thread.id);
  current.pullRequests = ["https://github.com/example/project/pull/1"];
  await f.store.writeThread(current);
  await f.service.setWorktreePreferences({
    ...(await f.store.worktreePreferences.read()),
    deleteUnchanged: true,
  });
  await f.service.cleanupWorktrees();
  expect(await Bun.file(join(thread.worktree!.root, "app/file.txt")).exists()).toBe(true);
  await git(f.root, ["update-ref", "refs/remotes/origin/main", "main"]);
  await git(f.root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await f.service.setWorktreePreferences({
    ...(await f.store.worktreePreferences.read()),
    deleteUnchanged: false,
    deleteMerged: true,
  });
  const pr = { state: "open" as const, baseBranch: "main", defaultBranch: "main", endedAt: null };
  await f.service.cleanupWorktrees(async () => pr);
  expect(await Bun.file(join(thread.worktree!.root, "app/file.txt")).exists()).toBe(true);
  await writeFile(join(thread.worktree!.root, "app/file.txt"), "committed work");
  await git(thread.worktree!.root, ["add", "."]);
  await git(thread.worktree!.root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Change",
  ]);
  await f.service.cleanupWorktrees(async () => ({ ...pr, state: "merged" }));
  expect(await Bun.file(join(thread.worktree!.root, "app/file.txt")).exists()).toBe(true);
  await git(f.root, [
    "update-ref",
    "refs/remotes/origin/main",
    await git(thread.worktree!.root, ["rev-parse", "HEAD"]),
  ]);
  await f.service.cleanupWorktrees(async () => ({ ...pr, state: "merged" }));
  expect(await Bun.file(join(thread.worktree!.root, "app/file.txt")).exists()).toBe(false);
});

for (const action of ["send", "disable-cleanup"] as const) {
  test(`an in-flight cleanup yields to a newer ${action} action`, async () => {
    const f = await fixture();
    const thread = await f.start();
    await f.finish(thread);
    const persisted = await f.store.readThread(f.project.id, thread.id);
    persisted.updatedAt = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await f.store.writeThread(persisted);
    const preferences = {
      ...(await f.store.worktreePreferences.read()),
      inactiveDays: 30 as const,
    };
    await f.service.setWorktreePreferences(preferences);
    const checked = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const original = f.store.worktrees.hasChanges.bind(f.store.worktrees);
    f.store.worktrees.hasChanges = async (...args) => {
      checked.resolve();
      await proceed.promise;
      return original(...args);
    };
    const cleaning = f.service.cleanupWorktrees();
    await checked.promise;
    const next =
      action === "send"
        ? f.service.sendMessage({
            projectId: f.project.id,
            threadId: thread.id,
            text: "Continue here",
          })
        : f.service.setWorktreePreferences({ ...preferences, inactiveDays: 0 });
    proceed.resolve();
    await cleaning;
    await next;
    expect(await Bun.file(join(thread.worktree!.root, "app/file.txt")).exists()).toBe(true);
    if (action === "send") expect(f.runs).toHaveLength(2);
  });
}

for (const action of ["inventory", "removal"] as const) {
  test(`cloud access revoked during worktree ${action} does not disclose or remove the checkout`, async () => {
    const f = await fixture();
    const cloudPath = join(f.directory, "cloud");
    await mkdir(cloudPath);
    const cloud = (await f.store.open(cloudPath, "Cloud workspace")).project;
    let allowed = true;
    f.service.authorizeCloudProject = async () => {
      if (!allowed) throw new Error("Access revoked");
    };
    f.service.canAccessCloudProject = () => allowed;
    const thread = await f.service.startThread({
      projectId: cloud.id,
      executionProjectId: f.project.id,
      harness: "codex",
      prompt: "Private task",
      designIds: [],
    });
    await f.finish(thread);
    if (action === "inventory") {
      const bytes = f.store.worktrees.bytes.bind(f.store.worktrees);
      f.store.worktrees.bytes = async (...args) => {
        const result = await bytes(...args);
        allowed = false;
        return result;
      };
      expect((await f.service.worktreeStorage()).entries).toHaveLength(0);
    } else {
      const changes = f.store.worktrees.hasChanges.bind(f.store.worktrees);
      f.store.worktrees.hasChanges = async (...args) => {
        const result = await changes(...args);
        allowed = false;
        return result;
      };
      await expect(f.service.removeWorktree(cloud.id, thread.id)).rejects.toThrow();
    }
    expect(await Bun.file(join(thread.worktree!.root, "app/file.txt")).exists()).toBe(true);
  });
}
