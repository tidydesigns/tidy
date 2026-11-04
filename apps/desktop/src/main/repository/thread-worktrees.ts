import { lstat, mkdir, realpath, rm, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import type { ThreadWorktree } from "../../shared/contracts/thread-workspace";
import { worktreeNames } from "../../shared/models/worktree-names";
import {
  defaultWorktreePreferences,
  worktreePreferencesSchema,
  type WorktreePreferences,
} from "../../shared/contracts/worktree-settings";
import { git, repositoryRoot } from "./repository-context";

/** Worktrees stay outside the checkout and survive completion, shutdown and failed turns. */
export class ThreadWorktrees {
  private validations = new Map<string, Promise<void>>();
  constructor(
    private directory: string,
    private creationTimeoutMs = 120_000,
  ) {}

  async create(
    projectPath: string,
    threadId: string,
    preferences: WorktreePreferences = defaultWorktreePreferences,
    title = "",
  ): Promise<ThreadWorktree> {
    preferences = worktreePreferencesSchema.parse(preferences);
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
    const { name, branch } = worktreeNames(threadId, preferences, title);
    const root = join(parent, name);
    await git(projectPath, ["check-ref-format", "--branch", branch]);
    // Reserve the destination exclusively so rollback can never remove an existing worktree.
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      throw new Error(
        error.code === "EEXIST"
          ? "This thread's worktree directory already exists. Start a new thread."
          : "Could not create this thread's worktree directory.",
      );
    });
    const mutate = (args: string[], timeout = 10_000) =>
      git(projectPath, ["-c", "core.hooksPath=/dev/null", ...args], timeout);
    let createdBranch = false;
    try {
      await mutate(["branch", branch, baseCommit]);
      createdBranch = true;
      // Skip hooks and leave the original checkout and its ignored environment files intact.
      await mutate(["worktree", "add", root, branch], this.creationTimeoutMs);
    } catch {
      if (createdBranch) {
        await mutate(["worktree", "remove", "--force", root]).catch(() => {});
        // Never delete a branch that gained commits while checkout was in progress.
        await mutate(["update-ref", "-d", `refs/heads/${branch}`, baseCommit]).catch(() => {});
      }
      await rm(root, { recursive: true, force: true }).catch(() => {});
      throw new Error("Could not create this thread's worktree. Retry or choose Current folder.");
    }
    return { root, path: join(root, relative(repository, projectPath)), branch, baseCommit };
  }

  async hasChanges(projectPath: string, worktree: ThreadWorktree) {
    await this.validateBinding(projectPath, worktree);
    // Include untracked AND ignored files: dependencies and local env files are user data too.
    return Boolean(
      await git(worktree.root, [
        "-c",
        "core.fsmonitor=false",
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=none",
      ]),
    );
  }

  async bytes(projectPath: string, worktree: ThreadWorktree) {
    await this.validateBinding(projectPath, worktree);
    let bytes = 0;
    let count = 0;
    const visit = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (++count > 250_000) throw new Error("This worktree is too large to measure.");
        const target = join(path, entry.name);
        const info = await lstat(target);
        // Never follow symlinks or traverse Git's shared object database.
        if (info.isDirectory() && !info.isSymbolicLink()) await visit(target);
        else bytes += info.size;
      }
    };
    await visit(worktree.root);
    return bytes;
  }

  async remove(
    projectPath: string,
    worktree: ThreadWorktree,
    admitted: () => boolean = () => true,
  ) {
    if (await this.hasChanges(projectPath, worktree))
      throw new Error(
        "This worktree has local changes or ignored files. Keep or move them before removing it.",
      );
    const attached = await git(worktree.root, ["symbolic-ref", "--quiet", "HEAD"]).catch(
      () => null,
    );
    if (!attached)
      throw new Error(
        "This worktree has a detached HEAD. Create or switch to a branch before removing it.",
      );
    if (!admitted()) throw new Error("This worktree is in use. Wait for its work to finish.");
    // Git performs the final dirty/locked/submodule check. Never force removal or delete the branch.
    await git(
      projectPath,
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "worktree",
        "remove",
        worktree.root,
      ],
      120_000,
    );
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
    if (
      !child ||
      isAbsolute(child) ||
      child.includes(sep) ||
      !(/^[a-z0-9][a-z0-9-]{0,47}-[a-f0-9]{8}$/.test(child) || z.uuid().safeParse(child).success)
    )
      throw new Error("This thread's worktree location is invalid.");
    const within = relative(worktree.root, worktree.path);
    if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
      throw new Error("This thread's working directory is invalid.");
    if (
      (await realpath(worktree.root)) !== worktree.root ||
      (await realpath(worktree.path)) !== worktree.path
    )
      throw new Error("This thread's worktree moved. Restore it before continuing.");
    const [original, actual] = await Promise.all([
      git(projectPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(worktree.path, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-toplevel",
      ]),
    ]);
    if (actual !== `${original}\n${worktree.root}`)
      throw new Error("This thread's worktree no longer belongs to its project.");
  }
}
