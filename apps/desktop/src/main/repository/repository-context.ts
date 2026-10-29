import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import {
  branchNameSchema,
  branchSwitchMessages,
  type BranchSwitchReason,
  repositoryContextSchema,
} from "../../shared/contracts/repository-context";

const execute = promisify(execFile);

async function git(cwd: string, args: string[]) {
  // Terminal Git overrides must not redirect operations away from the selected project.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
  );
  const { stdout } = await execute("git", args, {
    cwd,
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...environment, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
  return stdout.trim();
}

export async function repositoryRoot(cwd: string) {
  return git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => null);
}

export async function readRepositoryContext(cwd: string) {
  const machine = hostname();
  try {
    await git(cwd, ["rev-parse", "--git-dir"]);
  } catch {
    return repositoryContextSchema.parse({
      machine,
      branch: null,
      branches: [],
      repository: false,
    });
  }
  const [branch, refs] = await Promise.all([
    git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => null),
    git(cwd, ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads/"]),
  ]);
  return repositoryContextSchema.parse({
    machine,
    branch,
    branches: refs ? refs.split("\n") : [],
    repository: true,
  });
}

export async function switchRepositoryBranch(cwd: string, value: string) {
  const branch = branchNameSchema.parse(value);
  const context = await readRepositoryContext(cwd);
  if (!context.repository || !context.branches.includes(branch))
    throw new BranchSwitchError("missing-branch");
  if (branch !== context.branch) {
    try {
      await git(cwd, [
        "-c",
        "core.hooksPath=/dev/null",
        "switch",
        "--no-guess",
        "--no-overwrite-ignore",
        branch,
      ]);
    } catch (cause) {
      throw new BranchSwitchError(classifyBranchSwitchError(cause), { cause });
    }
  }
  // A successful switch establishes HEAD; another read must not turn it into a failure.
  return { ...context, branch };
}

export class BranchSwitchError extends Error {
  constructor(
    readonly reason: BranchSwitchReason,
    options?: ErrorOptions,
  ) {
    super(branchSwitchMessages[reason], options);
  }
}

function classifyBranchSwitchError(error: unknown): BranchSwitchReason {
  if (!(error instanceof Error)) return "failed";
  if ("code" in error && error.code === "ENOENT") return "git-unavailable";
  if ("killed" in error && error.killed === true) return "timeout";
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  if (/already (?:checked out|used by worktree)/i.test(stderr)) return "branch-in-use";
  if (/would be overwritten|would be lost/i.test(stderr)) return "local-changes";
  if (/index\.lock/i.test(stderr)) return "index-locked";
  if (/cannot switch branch while|resolve your current index/i.test(stderr))
    return "operation-in-progress";
  if (/invalid reference|a branch is expected/i.test(stderr)) return "missing-branch";
  return "failed";
}
