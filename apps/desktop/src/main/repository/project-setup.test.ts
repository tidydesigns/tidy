import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  matchingCheckouts,
  repositoryKey,
  repositoryURLSchema,
  projectSetupSchema,
} from "../../shared/contracts/project-setup";
import {
  projectDirectories,
  projectRemotes,
  projectRepositoryPath,
  setupProject,
} from "./project-setup";

const execute = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tidy-project-setup-"));
  temporary.push(root);
  const path = join(root, "project");
  await mkdir(path);
  await execute("git", ["init", "-b", "main"], { cwd: path });
  return { root, path, git: (args: string[]) => execute("git", args, { cwd: path }) };
}

test("matches SSH and HTTPS identities while preserving distinct hosts and repositories", () => {
  expect(repositoryKey("git@github.com:Team/Project.git")).toBe(
    repositoryKey("https://github.com/team/project"),
  );
  expect(repositoryKey("ssh://git@github.com:22/team/project.git")).toBe("github.com/team/project");
  expect(repositoryKey("https://git.example/team/Project")).not.toBe(
    repositoryKey("https://git.example/team/project"),
  );
  for (const value of [
    "ext::command",
    "file:///tmp/repo",
    "/tmp/repo",
    "--upload-pack=command",
    "https://user:secret@example.com/repo",
    "https://user@example.com/repo",
    "https://host/repo?token=secret",
    "git@host:team/repo\ncommand",
  ])
    expect(repositoryURLSchema.safeParse(value).success).toBe(false);
});

test("does not match forks through a shared upstream or assume matching project IDs identify a checkout", () => {
  const id = crypto.randomUUID();
  const source = {
    projectId: id,
    repositoryPath: "",
    remotes: ["https://git.example/me/project", "https://git.example/team/project"],
  };
  const matching = {
    projectId: crypto.randomUUID(),
    repositoryPath: "",
    remotes: ["git@git.example:me/project.git"],
  };
  expect(
    matchingCheckouts({
      source,
      candidates: [
        { projectId: id, repositoryPath: "", remotes: ["https://git.example/team/project"] },
        matching,
      ],
    }),
  ).toEqual([matching]);
  expect(
    matchingCheckouts({
      source: { projectId: id, repositoryPath: "", remotes: [] },
      candidates: [{ projectId: id, repositoryPath: "", remotes: [] }],
    }),
  ).toEqual([]);
});

test("reads real remotes, prioritizes origin, and verifies a selected existing folder", async () => {
  const { path, git } = await fixture();
  await git(["remote", "add", "aaa", "https://git.example/upstream/project.git"]);
  await git(["remote", "add", "origin", "git@git.example:team/project.git"]);
  expect(await projectRemotes(path)).toEqual([
    "git@git.example:team/project.git",
    "https://git.example/upstream/project.git",
  ]);
  expect(
    await setupProject({ kind: "folder", path, repository: "https://git.example/team/project" }),
  ).toEqual({ kind: "ready", path });
  expect(
    await setupProject({
      kind: "folder",
      path,
      repository: "https://git.example/upstream/project",
    }),
  ).toEqual({ kind: "repository-mismatch", repository: "git@git.example:team/project.git" });
  expect(await setupProject({ kind: "folder", path, repository: null })).toEqual({
    kind: "ready",
    path,
  });
  expect((await projectRemotes(path))[0]).toBe("git@git.example:team/project.git");
});

test("browses the selected host filesystem without exposing hidden directories", async () => {
  const { root } = await fixture();
  await mkdir(join(root, ".private"));
  const directory = await projectDirectories(root);
  expect(directory.path).toBe(root);
  expect(directory.directories.map((item) => item.name)).toEqual(["project"]);
});

test("clone never overwrites an existing folder and removes only its own failed destination", async () => {
  const { root, path } = await fixture();
  await writeFile(join(path, "keep.txt"), "keep");
  expect(
    await setupProject({
      kind: "clone",
      parent: root,
      repository: "ssh://localhost:1/team/project.git",
    }),
  ).toEqual({ kind: "failed", reason: "destination-unavailable" });
  expect(await readFile(join(path, "keep.txt"), "utf8")).toBe("keep");
  expect(
    await setupProject({
      kind: "clone",
      parent: root,
      repository: "ssh://localhost:1/team/missing.git",
    }),
  ).toEqual({ kind: "failed", reason: "clone-failed" });
  expect(await readdir(root)).toEqual(["project"]);
});

test("missing folders and folders without a remote return explicit setup results", async () => {
  const { root, path } = await fixture();
  await writeFile(join(root, "file.txt"), "file");
  expect(
    await setupProject({ kind: "folder", path: join(root, "file.txt"), repository: null }),
  ).toEqual({ kind: "failed", reason: "folder-unavailable" });
  expect(
    await setupProject({
      kind: "clone",
      parent: root,
      repository: "https://git.example/team/repo%20name",
    }),
  ).toEqual({ kind: "failed", reason: "invalid-repository" });
  expect(
    await setupProject({ kind: "folder", path, repository: "https://git.example/team/project" }),
  ).toEqual({ kind: "repository-mismatch", repository: null });
  expect(
    await setupProject({ kind: "folder", path: join(root, "missing"), repository: null }),
  ).toEqual({ kind: "failed", reason: "folder-unavailable" });
  expect(
    await setupProject({
      kind: "clone",
      parent: join(root, "missing"),
      repository: "https://git.example/team/project",
    }),
  ).toEqual({ kind: "failed", reason: "folder-unavailable" });
});

test("matching repositories do not automatically group different folders in a monorepo", async () => {
  const { path, git } = await fixture();
  await git(["remote", "add", "origin", "https://git.example/team/project"]);
  const nested = join(path, "packages", "app");
  await mkdir(nested, { recursive: true });
  expect(await projectRepositoryPath(path)).toBe("");
  expect(await projectRepositoryPath(nested)).toBe("packages/app/");
  const source = {
    projectId: crypto.randomUUID(),
    remotes: await projectRemotes(nested),
    repositoryPath: await projectRepositoryPath(nested),
  };
  const root = {
    projectId: crypto.randomUUID(),
    remotes: await projectRemotes(path),
    repositoryPath: await projectRepositoryPath(path),
  };
  expect(matchingCheckouts({ source, candidates: [root] })).toEqual([]);
  expect(
    matchingCheckouts({ source, candidates: [{ ...root, repositoryPath: "packages/app/" }] }),
  ).toHaveLength(1);
});

test("clone paths cannot escape the repository", () => {
  for (const repositoryPath of ["../outside", "/outside", "packages/../../outside"]) {
    expect(
      projectSetupSchema.safeParse({
        kind: "clone",
        parent: "/tmp",
        repository: "https://git.example/team/project",
        repositoryPath,
      }).success,
    ).toBe(false);
  }
  expect(
    projectSetupSchema.safeParse({
      kind: "clone",
      parent: "/tmp",
      repository: "https://git.example/team/project",
      repositoryPath: "packages/app/",
    }).success,
  ).toBe(true);
});

test("an unsupported primary remote cannot match a fork through its upstream", async () => {
  const { path, git } = await fixture();
  await git(["remote", "add", "origin", "https://user:fixture-password@git.example/me/project"]);
  await git(["remote", "add", "upstream", "https://git.example/team/project"]);
  expect(await projectRemotes(path)).toEqual([]);
});
