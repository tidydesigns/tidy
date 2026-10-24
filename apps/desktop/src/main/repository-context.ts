import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { branchNameSchema, repositoryContextSchema } from "../shared/repository-context";

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
    env: { ...environment, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
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
    throw new Error("Choose an existing local branch.");
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
    } catch {
      throw new Error("Could not switch branches. Check local changes and other worktrees.");
    }
    // A successful switch establishes HEAD; another read must not turn it into a failure.
    return { ...context, branch };
  }
  return readRepositoryContext(cwd);
}
