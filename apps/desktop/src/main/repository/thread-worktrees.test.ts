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
