import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./repository-context";
import { ThreadWorktrees } from "./thread-worktrees";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tidy-worktree-rollback-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "project");
  await mkdir(root);
  await git(root, ["init", "-b", "main"]);
  await writeFile(join(root, "file.txt"), "committed");
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
  const worktrees = join(directory, "worktrees");
  return { directory, root, worktrees };
}

for (const failure of ["exit", "timeout"] as const) {
  test(`a checkout ${failure} rolls back only its own worktree and branch and permits retry`, async () => {
    const f = await fixture();
    const executable = Bun.which("git");
    if (!executable) throw new Error("Git is required.");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const bin = join(f.directory, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\nprevious=''\nfor arg in "$@"; do\nif [ "$previous" = worktree ] && [ "$arg" = add ]; then\n${quote(executable)} "$@" || exit $?\n${failure === "timeout" ? "exec /bin/sleep 30" : "exit 17"}\nfi\nprevious="$arg"\ndone\nexec ${quote(executable)} "$@"\n`,
      { mode: 0o700 },
    );
    const threadId = randomUUID();
    const manager = new ThreadWorktrees(f.worktrees, failure === "timeout" ? 500 : 120_000);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = bin;
      await expect(manager.create(f.root, threadId)).rejects.toThrow("Could not create");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    expect(await Bun.file(join(f.worktrees, threadId, "file.txt")).exists()).toBe(false);
    expect(await git(f.root, ["branch", "--list", `feat/tidy-${threadId}`])).toBe("");
    expect(
      (await git(f.root, ["worktree", "list", "--porcelain"])).match(/worktree /g),
    ).toHaveLength(1);
    const retried = await manager.create(f.root, threadId);
    expect(await readFile(join(retried.path, "file.txt"), "utf8")).toBe("committed");
  });
}

test("creation failure preserves a pre-existing branch and an existing worktree's edits", async () => {
  const f = await fixture();
  const manager = new ThreadWorktrees(f.worktrees);
  const existingId = randomUUID();
  const branch = `feat/tidy-${existingId}`;
  await git(f.root, ["branch", branch]);
  const before = await git(f.root, ["rev-parse", `refs/heads/${branch}`]);
  await expect(manager.create(f.root, existingId)).rejects.toThrow("Could not create");
  expect(await git(f.root, ["rev-parse", `refs/heads/${branch}`])).toBe(before);
  const threadId = randomUUID();
  const worktree = await manager.create(f.root, threadId);
  await writeFile(join(worktree.path, "file.txt"), "unfinished user edits");
  await expect(manager.create(f.root, threadId)).rejects.toThrow("already exists");
  expect(await readFile(join(worktree.path, "file.txt"), "utf8")).toBe("unfinished user edits");
});

test("UUID remains the default; readable names are safe, bounded and stable", async () => {
  const f = await fixture();
  const manager = new ThreadWorktrees(f.worktrees);
  const id = randomUUID();
  const defaults = await manager.create(f.root, id);
  expect(defaults.root).toBe(join(f.worktrees, id));
  expect(defaults.branch).toBe(`feat/tidy-${id}`);
  const { defaultWorktreePreferences } = await import("../../shared/contracts/worktree-settings");
  const shortId = randomUUID();
  const readable = await manager.create(
    f.root,
    shortId,
    { ...defaultWorktreePreferences, naming: "prompt", branchPrefix: "fix/" },
    "../../ Résumé storage! $() / ready",
  );
  expect(readable.branch).toBe(`fix/resume-storage-ready-${shortId.slice(0, 8)}`);
  expect(readable.root).toBe(join(f.worktrees, `resume-storage-ready-${shortId.slice(0, 8)}`));
  await manager.validate(f.root, readable);
  const fallbackId = randomUUID();
  const fallback = await manager.create(
    f.root,
    fallbackId,
    { ...defaultWorktreePreferences, naming: "prompt" },
    "🎨",
  );
  expect(fallback.branch).toBe(`feat/tidy-thread-${fallbackId.slice(0, 8)}`);
});

test("prefix validation prevents ref/path injection and readable-name collisions keep existing data", async () => {
  const f = await fixture();
  const manager = new ThreadWorktrees(f.worktrees);
  const { defaultWorktreePreferences, worktreePreferencesSchema } =
    await import("../../shared/contracts/worktree-settings");
  for (const branchPrefix of [
    "../",
    "--bad",
    "feat/../",
    "feat/@{",
    "foo.lock/",
    "$(touch x)-",
    "feat/space -",
  ])
    expect(worktreePreferencesSchema.safeParse({ branchPrefix }).success).toBe(false);
  const preferences = { ...defaultWorktreePreferences, naming: "prompt" as const };
  const first = await manager.create(
    f.root,
    "12345678-1234-4234-8234-123456789012",
    preferences,
    "same task",
  );
  await writeFile(join(first.root, "file.txt"), "local data");
  await expect(
    manager.create(f.root, "12345678-5678-4678-8678-567856785678", preferences, "same task"),
  ).rejects.toThrow("already exists");
  expect(await readFile(join(first.root, "file.txt"), "utf8")).toBe("local data");
});

for (const kind of ["tracked", "untracked", "ignored", "locked"] as const) {
  test(`removal preserves a worktree containing ${kind} data`, async () => {
    const f = await fixture();
    const manager = new ThreadWorktrees(f.worktrees);
    const worktree = await manager.create(f.root, randomUUID());
    if (kind === "tracked") await writeFile(join(worktree.root, "file.txt"), "edited");
    if (kind === "untracked") await writeFile(join(worktree.root, "new.txt"), "new data");
    if (kind === "ignored") {
      await writeFile(join(f.root, ".git/info/exclude"), ".env.local\n");
      await writeFile(join(worktree.root, ".env.local"), "LOCAL_FIXTURE=private");
    }
    if (kind === "locked") await git(f.root, ["worktree", "lock", worktree.root]);
    await expect(manager.remove(f.root, worktree)).rejects.toThrow();
    expect(await Bun.file(join(worktree.root, "file.txt")).exists()).toBe(true);
    expect(await git(f.root, ["rev-parse", worktree.branch])).toBe(worktree.baseCommit);
  });
}

test("removal retains the branch and checks admission again after async validation", async () => {
  const f = await fixture();
  const manager = new ThreadWorktrees(f.worktrees);
  const worktree = await manager.create(f.root, randomUUID());
  await expect(manager.remove(f.root, worktree, () => false)).rejects.toThrow("in use");
  expect(await manager.bytes(f.root, worktree)).toBeGreaterThan(0);
  await manager.remove(f.root, worktree);
  expect(await Bun.file(join(worktree.root, "file.txt")).exists()).toBe(false);
  expect(await git(f.root, ["rev-parse", worktree.branch])).toBe(worktree.baseCommit);
});

test("a detached checkout is kept so removing it cannot orphan unreferenced commits", async () => {
  const f = await fixture();
  const manager = new ThreadWorktrees(f.worktrees);
  const worktree = await manager.create(f.root, randomUUID());
  await git(worktree.root, ["switch", "--detach"]);
  await expect(manager.remove(f.root, worktree)).rejects.toThrow("detached HEAD");
  expect(await Bun.file(join(worktree.root, "file.txt")).exists()).toBe(true);
});
