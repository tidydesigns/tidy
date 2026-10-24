import { afterEach, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { repositoryContextSchema } from "../shared/repository-context";
import { readRepositoryContext, switchRepositoryBranch } from "./repository-context";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tidy-branches-"));
  directories.push(cwd);
  const git = (args: string[]) => execute("git", args, { cwd });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await writeFile(join(cwd, "file.txt"), "main\n");
  await git(["add", "file.txt"]);
  await git(["commit", "-m", "Initial"]);
  await git(["switch", "-c", "feature"]);
  await writeFile(join(cwd, "file.txt"), "feature\n");
  await git(["commit", "-am", "Feature"]);
  await git(["switch", "main"]);
  return { cwd, git };
}

test("reads machine and local branches, and switches to an existing branch", async () => {
  const { cwd } = await fixture();
  expect(await readRepositoryContext(cwd)).toEqual({
    machine: hostname(),
    repository: true,
    branch: "main",
    branches: ["feature", "main"],
  });
  expect((await switchRepositoryBranch(cwd, "feature")).branch).toBe("feature");
  expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("feature\n");
});

test("rejects options and missing branches without changing HEAD", async () => {
  const { cwd } = await fixture();
  for (const branch of ["--detach", "missing", "main\nfeature"])
    await expect(switchRepositoryBranch(cwd, branch)).rejects.toThrow();
  expect((await readRepositoryContext(cwd)).branch).toBe("main");
});

test.each(["repository", "index", "config"] as const)(
  "ignores inherited Git %s overrides and leaves the other repository untouched",
  async (override) => {
    const selected = await fixture();
    const other = await fixture();
    const otherIndex = await readFile(join(other.cwd, ".git/index"));
    const overrides = {
      repository: {
        GIT_DIR: join(other.cwd, ".git"),
        GIT_COMMON_DIR: join(other.cwd, ".git"),
        GIT_WORK_TREE: other.cwd,
        GIT_OBJECT_DIRECTORY: join(other.cwd, ".git/objects"),
      },
      index: { GIT_INDEX_FILE: join(other.cwd, ".git/index") },
      config: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.bare",
        GIT_CONFIG_VALUE_0: "true",
      },
    }[override];
    const module = new URL("./repository-context.ts", import.meta.url).href;
    const { stdout } = await execute(
      process.execPath,
      [
        "-e",
        `import { repositoryRoot, readRepositoryContext, switchRepositoryBranch } from ${JSON.stringify(module)};
const cwd = ${JSON.stringify(selected.cwd)};
console.log(JSON.stringify({root: await repositoryRoot(cwd), before: await readRepositoryContext(cwd), after: await switchRepositoryBranch(cwd, "feature")}));`,
      ],
      { env: { ...process.env, ...overrides } },
    );
    const result = JSON.parse(stdout);
    expect(result.root).toBe(
      await selected.git(["rev-parse", "--show-toplevel"]).then((r) => r.stdout.trim()),
    );
    expect(repositoryContextSchema.parse(result.before).branch).toBe("main");
    expect(repositoryContextSchema.parse(result.after).branch).toBe("feature");
    expect((await readRepositoryContext(selected.cwd)).branch).toBe("feature");
    expect((await readRepositoryContext(other.cwd)).branch).toBe("main");
    expect(await readFile(join(selected.cwd, "file.txt"), "utf8")).toBe("feature\n");
    expect(await readFile(join(other.cwd, "file.txt"), "utf8")).toBe("main\n");
    expect(await readFile(join(other.cwd, ".git/index"))).toEqual(otherIndex);
  },
);

test("preserves conflicting uncommitted work and does not run checkout hooks", async () => {
  const { cwd } = await fixture();
  await writeFile(join(cwd, "file.txt"), "unsaved work\n");
  await expect(switchRepositoryBranch(cwd, "feature")).rejects.toThrow("local changes");
  expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("unsaved work\n");
  await writeFile(join(cwd, "file.txt"), "main\n");
  const marker = join(cwd, "hook-ran");
  await writeFile(join(cwd, ".git/hooks/post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, {
    mode: 0o755,
  });
  await switchRepositoryBranch(cwd, "feature");
  await expect(readFile(marker)).rejects.toThrow();
});

test("reports detached HEAD and folders outside a repository", async () => {
  const { cwd, git } = await fixture();
  await git(["switch", "--detach"]);
  expect((await readRepositoryContext(cwd)).branch).toBeNull();
  const plain = await mkdtemp(join(tmpdir(), "tidy-plain-"));
  directories.push(plain);
  expect((await readRepositoryContext(plain)).repository).toBe(false);
});

test("preserves ignored application data when the target branch tracks the same path", async () => {
  const { cwd, git } = await fixture();
  const metadata = join(cwd, ".tidy/project.json");
  await writeFile(join(cwd, ".git/info/exclude"), ".tidy/\n");
  await git(["switch", "feature"]);
  await mkdir(join(cwd, ".tidy"));
  await writeFile(metadata, "branch-owned data\n");
  await git(["add", "-f", ".tidy/project.json"]);
  await git(["commit", "-m", "Track colliding metadata"]);
  await git(["switch", "main"]);
  await mkdir(join(cwd, ".tidy"), { recursive: true });
  await writeFile(metadata, "local application data\n");

  await expect(switchRepositoryBranch(cwd, "feature")).rejects.toThrow("local changes");
  expect(await readFile(metadata, "utf8")).toBe("local application data\n");
  expect((await readRepositoryContext(cwd)).branch).toBe("main");
});

test("returns the switched branch even when Git becomes unavailable after switching", async () => {
  const { cwd } = await fixture();
  const bin = join(cwd, "bin");
  const marker = join(cwd, "switched");
  await mkdir(bin);
  const realGit = Bun.which("git");
  expect(realGit).not.toBeNull();
  await writeFile(
    join(bin, "git"),
    `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const marker = ${JSON.stringify(marker)};
if (existsSync(marker)) process.exit(1);
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, { encoding: "utf8" });
if (result.status === 0 && args.includes("switch")) writeFileSync(marker, "done");
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  const module = new URL("./repository-context.ts", import.meta.url).href;
  const { stdout } = await execute(
    process.execPath,
    [
      "-e",
      `import { switchRepositoryBranch } from ${JSON.stringify(module)};
console.log(JSON.stringify(await switchRepositoryBranch(${JSON.stringify(cwd)}, "feature")));`,
    ],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  );
  expect(repositoryContextSchema.parse(JSON.parse(stdout)).branch).toBe("feature");
  expect((await readRepositoryContext(cwd)).branch).toBe("feature");
});

for (const action of ["close", "prepareUpdate"] as const) {
  test(`${action} waits for an accepted branch switch before flushing`, async () => {
    const { cwd } = await fixture();
    const store = new ProjectStore(join(cwd, "state"));
    await store.initialize();
    const { project } = await store.open(cwd);
    const service = new WorkspaceService(store);
    let branchAtFlush: string | null | undefined;
    const flush = store.flush.bind(store);
    const flushSpy = spyOn(store, "flush").mockImplementation(async () => {
      branchAtFlush = (await readRepositoryContext(cwd)).branch;
      await flush();
    });
    try {
      const switching = service.switchBranch(project.id, "feature");
      const closing = service[action]();
      await expect(service.switchBranch(project.id, "main")).rejects.toThrow("closing");
      const resume = await closing;
      expect(branchAtFlush).toBe("feature");
      expect((await switching).branch).toBe("feature");
      resume?.();
    } finally {
      flushSpy.mockRestore();
      await service.close();
    }
  });
}

test("serializes branch switches and blocks thread launches during a switch", async () => {
  const { cwd } = await fixture();
  const store = new ProjectStore(join(cwd, "state"));
  await store.initialize();
  const { project } = await store.open(cwd);
  const service = new WorkspaceService(store);
  const threadLookup = spyOn(store, "threadExists");
  try {
    const switching = service.switchBranch(project.id, "feature");
    await expect(service.switchBranch(project.id, "main")).rejects.toThrow("branch switch");
    await expect(
      service.startThread({
        projectId: project.id,
        harness: "codex",
        prompt: "Hello",
        designIds: [],
      }),
    ).rejects.toThrow("branch switch");
    expect(threadLookup).not.toHaveBeenCalled();
    await switching;
  } finally {
    threadLookup.mockRestore();
    await service.close();
  }
});

test("cannot change branches underneath an active thread", async () => {
  const { cwd } = await fixture();
  const store = new ProjectStore(join(cwd, "state"));
  await store.initialize();
  const { project } = await store.open(cwd);
  const completion = Promise.withResolvers<void>();
  const service = new WorkspaceService(
    store,
    () => ({ done: completion.promise, stop: () => completion.resolve() }),
    async () => "/fixture/agent",
    async () => {},
  );
  try {
    await service.startThread({
      projectId: project.id,
      harness: "codex",
      prompt: "Hello",
      designIds: [],
    });
    await expect(service.switchBranch(project.id, "feature")).rejects.toThrow("active work");
    expect((await readRepositoryContext(cwd)).branch).toBe("main");
  } finally {
    completion.resolve();
    await service.close();
  }
});

test("guards active nested projects in the same working tree", async () => {
  const { cwd } = await fixture();
  await mkdir(join(cwd, "nested"));
  const store = new ProjectStore(join(cwd, "state"));
  await store.initialize();
  const root = await store.open(cwd);
  const nested = await store.open(join(cwd, "nested"));
  const completion = Promise.withResolvers<void>();
  const service = new WorkspaceService(
    store,
    () => ({ done: completion.promise, stop: () => completion.resolve() }),
    async () => "/fixture/agent",
    async () => {},
  );
  try {
    await service.startThread({
      projectId: nested.project.id,
      harness: "codex",
      prompt: "Hello",
      designIds: [],
    });
    await expect(service.switchBranch(root.project.id, "feature")).rejects.toThrow("active work");
    expect((await readRepositoryContext(cwd)).branch).toBe("main");
  } finally {
    completion.resolve();
    await service.close();
  }
});

test("repository responses reject branch state for folders outside Git", () => {
  const plain = { machine: "test", repository: false, branch: null, branches: [] };
  expect(repositoryContextSchema.safeParse(plain).success).toBe(true);
  expect(repositoryContextSchema.safeParse({ ...plain, branch: "main" }).success).toBe(false);
  expect(repositoryContextSchema.safeParse({ ...plain, branches: ["main"] }).success).toBe(false);
  expect(repositoryContextSchema.safeParse({ ...plain, repository: true }).success).toBe(true);
});

test("rejects an unverified target root and permits retry after recovery", async () => {
  const { cwd } = await fixture();
  const store = new ProjectStore(join(cwd, "state"));
  await store.initialize();
  const { project } = await store.open(cwd);
  const service = new WorkspaceService(store);
  try {
    await rename(join(cwd, ".git"), join(cwd, ".git-unavailable"));
    await expect(service.switchBranch(project.id, "feature")).rejects.toThrow("repository root");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("main\n");
    await rename(join(cwd, ".git-unavailable"), join(cwd, ".git"));
    expect((await service.switchBranch(project.id, "feature")).branch).toBe("feature");
  } finally {
    await service.close();
  }
});

test("rejects switching when an active project's root cannot be verified", async () => {
  const target = await fixture();
  const active = await fixture();
  const store = new ProjectStore(join(target.cwd, "state"));
  await store.initialize();
  const targetProject = await store.open(target.cwd);
  const activeProject = await store.open(active.cwd);
  const completion = Promise.withResolvers<void>();
  const service = new WorkspaceService(
    store,
    () => ({ done: completion.promise, stop: () => completion.resolve() }),
    async () => "/fixture/agent",
    async () => {},
  );
  try {
    await service.startThread({
      projectId: activeProject.project.id,
      harness: "codex",
      prompt: "Hello",
      designIds: [],
    });
    await rename(join(active.cwd, ".git"), join(active.cwd, ".git-unavailable"));
    await expect(service.switchBranch(targetProject.project.id, "feature")).rejects.toThrow(
      "active project's repository root",
    );
    expect((await readRepositoryContext(target.cwd)).branch).toBe("main");
    await rename(join(active.cwd, ".git-unavailable"), join(active.cwd, ".git"));
    expect((await service.switchBranch(targetProject.project.id, "feature")).branch).toBe(
      "feature",
    );
  } finally {
    completion.resolve();
    await service.close();
  }
});
