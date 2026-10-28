import { execFile } from "node:child_process";
import { mkdir, realpath, rm, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  repositoryKey,
  type ProjectSetupIssue,
  repositoryURLSchema,
  type ProjectSetup,
} from "../../shared/contracts/project-setup";

const execute = promisify(execFile);
export async function projectDirectories(input: string) {
  const path = await realpath(input || homedir());
  const entries = await readdir(path, { withFileTypes: true });
  return {
    path,
    parent: dirname(path) === path ? null : dirname(path),
    initialProject: "",
    directories: entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({ name: entry.name, path: join(path, entry.name) })),
  };
}
async function projectGit(cwd: string, args: string[], timeout = 10_000) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  const { stdout } = await execute(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.file.allow=never",
      "-c",
      "protocol.ext.allow=never",
      ...args,
    ],
    {
      cwd,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  return stdout.trim();
}

export async function projectRepositoryPath(path: string) {
  return projectGit(path, ["rev-parse", "--show-prefix"]).catch(() => null);
}

export async function projectRemotes(path: string) {
  const names = await projectGit(path, ["remote"]).catch(() => "");
  const remotes: string[] = [];
  for (const name of names
    .split("\n")
    .filter(Boolean)
    .sort((a, b) => (a === "origin" ? -1 : b === "origin" ? 1 : a.localeCompare(b)))
    .slice(0, 100)) {
    const value = await projectGit(path, ["remote", "get-url", "--", name]).catch(() => "");
    const parsed = repositoryURLSchema.safeParse(value);
    if (!parsed.success && remotes.length === 0) return [];
    if (parsed.success) remotes.push(parsed.data);
  }
  return remotes;
}

async function resolveDirectory(input: string) {
  try {
    const path = await realpath(input);
    return (await stat(path)).isDirectory() ? path : null;
  } catch {
    return null;
  }
}

export async function setupProject(
  input: ProjectSetup,
): Promise<{ kind: "ready"; path: string } | ProjectSetupIssue> {
  if (input.kind === "folder") {
    const path = await resolveDirectory(input.path);
    if (!path) return { kind: "failed", reason: "folder-unavailable" };
    if (input.repository) {
      const expected = repositoryKey(input.repository);
      const remotes = await projectRemotes(path);
      if (!remotes[0] || repositoryKey(remotes[0]) !== expected)
        return { kind: "repository-mismatch", repository: remotes[0] ?? null };
    }
    return { kind: "ready", path };
  }
  const parent = await resolveDirectory(input.parent);
  if (!parent) return { kind: "failed", reason: "folder-unavailable" };
  const key = repositoryKey(input.repository);
  if (!key) return { kind: "failed", reason: "invalid-repository" };
  const name = basename(key);
  if (!/^[\w.-]+$/.test(name) || name === "." || name === "..")
    return { kind: "failed", reason: "invalid-repository" };
  const path = join(parent, name);
  const created = await mkdir(path, { mode: 0o700 }).then(
    () => true,
    () => false,
  );
  if (!created) return { kind: "failed", reason: "destination-unavailable" };
  try {
    await projectGit(parent, ["clone", "--", input.repository, path], 300_000);
  } catch {
    await rm(path, { recursive: true, force: true });
    return { kind: "failed", reason: "clone-failed" };
  }
  const projectPath = await resolveDirectory(join(path, input.repositoryPath ?? ""));
  return projectPath && (projectPath === path || projectPath.startsWith(`${path}/`))
    ? { kind: "ready", path: projectPath }
    : { kind: "failed", reason: "project-folder-missing" };
}
