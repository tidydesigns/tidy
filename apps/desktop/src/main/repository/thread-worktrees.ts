import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import type { ThreadWorktree } from "../../shared/contracts/thread-workspace";
import { git, repositoryRoot } from "./repository-context";

/** Worktrees stay outside the checkout and survive completion, shutdown and failed turns. */
export class ThreadWorktrees {
  private validations = new Map<string, Promise<void>>();
  constructor(private directory: string) {}

  async create(projectPath: string, threadId: string): Promise<ThreadWorktree> {
    z.uuid().parse(threadId);
    const repository = await repositoryRoot(projectPath);
    if (!repository) throw new Error("Choose Current folder for a project without Git.");
    const baseCommit = await git(projectPath, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(
      () => {
        throw new Error(
          "Make an initial commit or choose Current folder before starting a thread.",
        );
      },
    );
    const subdirectory = relative(repository, projectPath);
    if (subdirectory && !(await git(repository, ["ls-tree", "-d", baseCommit, "--", subdirectory])))
      throw new Error(
        "This project folder has no committed files. Choose Current folder or commit it first.",
      );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("The thread worktree directory must be a real directory.");
    const parent = await realpath(this.directory);
    const root = join(parent, threadId);
    const branch = `feat/tidy-${threadId}`;
    try {
      // Skip hooks and leave the original checkout and its ignored environment files intact.
      await git(projectPath, [
        "-c",
        "core.hooksPath=/dev/null",
        "worktree",
        "add",
        "-b",
        branch,
        root,
        baseCommit,
      ]);
    } catch {
      throw new Error("Could not create this thread's worktree. Retry or choose Current folder.");
    }
    return { root, path: join(root, relative(repository, projectPath)), branch, baseCommit };
  }

  validate(projectPath: string, worktree: ThreadWorktree) {
    const key = JSON.stringify([projectPath, worktree.root, worktree.path]);
    let pending = this.validations.get(key);
    if (!pending) {
      pending = this.validateBinding(projectPath, worktree).finally(() =>
        this.validations.delete(key),
      );
      this.validations.set(key, pending);
    }
    return pending;
  }

  private async validateBinding(projectPath: string, worktree: ThreadWorktree) {
    const parent = await realpath(this.directory);
    const child = relative(parent, worktree.root);
    if (!child || isAbsolute(child) || child.includes(sep) || !z.uuid().safeParse(child).success)
      throw new Error("This thread's worktree location is invalid.");
    const within = relative(worktree.root, worktree.path);
    if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
      throw new Error("This thread's working directory is invalid.");
    if (
      (await realpath(worktree.root)) !== worktree.root ||
      (await realpath(worktree.path)) !== worktree.path
    )
      throw new Error("This thread's worktree moved. Restore it before continuing.");
    const [original, actual, root] = await Promise.all([
      git(projectPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(worktree.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      repositoryRoot(worktree.path),
    ]);
    if (original !== actual || root !== worktree.root)
      throw new Error("This thread's worktree no longer belongs to its project.");
  }
}
