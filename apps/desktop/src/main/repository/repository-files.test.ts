import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  realpath,
  rename,
  chmod,
  readFile,
  stat,
  utimes,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  repositoryPathSchema,
  repositoryDirectorySchema,
  repositoryChangesSchema,
  repositoryFileSchema,
} from "../../shared/contracts/repository-files";
import {
  RepositoryObservers,
  readRepositoryDirectory,
  readRepositoryChanges,
  readRepositoryFile,
} from "./repository-files";
import { assertRepositoryPathStable, openRepositoryPath } from "./repository-path";
import { createGitView, closeGitView, closeGitSnapshots } from "./repository-git";
import { prepareFileRows } from "../../renderer/src/features/repository/file-rows";

const execute = promisify(execFile);
const scratch: string[] = [];
afterEach(async () => {
  await closeGitSnapshots();
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function gitEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
}
async function fixture(commit = true, format: "sha1" | "sha256" = "sha1") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tidy-repository-files-")));
  scratch.push(root);
  const git = (args: string[]) => execute("git", args, { cwd: root, env: gitEnvironment() });
  await git(["init", "-b", "main", `--object-format=${format}`]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(root, "file.txt"), "first\nlast\n");
  if (commit) {
    await git(["add", "."]);
    await git(["commit", "-m", "Fixture baseline"]);
  }
  return { root, git };
}

test("compares staged and unstaged contents against HEAD without changing the index", async () => {
  const { root, git } = await fixture();
  await writeFile(join(root, "file.txt"), "staged\nlast\n");
  await git(["add", "file.txt"]);
  await writeFile(join(root, "file.txt"), "working\nlast\n");
  const before = await git(["diff", "--cached"]);
  const file = await readRepositoryFile(root, "file.txt");
  expect(file.kind).toBe("text");
  if (file.kind !== "text") return;
  expect(file.view).toBe("diff");
  expect(file.text).toContain("-first");
  expect(file.text).toContain("+working");
  expect(file.text).not.toContain("+staged");
  expect((await git(["diff", "--cached"])).stdout).toBe(before.stdout);
  expect(
    prepareFileRows(file)
      .rows.filter((row) => row.kind === "lines" && row.changed && row.after !== null)
      .map((row) => (row.kind === "lines" ? row.after?.number : null)),
  ).toEqual([1]);
});

test("raw previews include the whole working file and remain available with a broken Git index", async () => {
  const { root, git } = await fixture();
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  await writeFile(join(root, "file.txt"), lines.join("\n") + "\n");
  await git(["commit", "-am", "Long fixture"]);
  lines[14] = "working change";
  const text = lines.join("\n") + "\n";
  await writeFile(join(root, "file.txt"), text);
  const diff = await readRepositoryFile(root, "file.txt");
  expect(diff.kind === "text" && diff.view).toBe("diff");
  expect(diff.kind === "text" && diff.text).not.toContain("line 1\n");
  const raw = { kind: "text", text, view: "file", comparison: "none" } as const;
  expect(await readRepositoryFile(root, "file.txt", undefined, "file")).toEqual(raw);
  await writeFile(join(root, ".git/index"), "broken index");
  await expect(readRepositoryChanges(root)).rejects.toThrow();
  expect(await readRepositoryFile(root, "file.txt", undefined, "file")).toEqual(raw);
});

test("raw previews retain path confinement and file limits without Git", async () => {
  const { root } = await fixture();
  await symlink(join(root, "file.txt"), join(root, "link.txt"));
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(join(root, "large"), "x".repeat(1024 * 1024 + 1));
  await writeFile(join(root, "empty"), "");
  await expect(readRepositoryFile(root, "../file.txt", undefined, "file")).rejects.toThrow();
  for (const [path, reason] of [
    ["binary", "binary"],
    ["missing", "missing"],
  ] as const)
    expect(await readRepositoryFile(root, path, undefined, "file")).toEqual({
      kind: "unavailable",
      reason,
    });
  expect(await readRepositoryFile(root, "link.txt", undefined, "file")).toEqual(
    await readRepositoryFile(root, "file.txt", undefined, "file"),
  );
  expect(await readRepositoryFile(root, "large", undefined, "file")).toEqual({
    kind: "text",
    text: "x".repeat(1024 * 1024),
    view: "file",
    comparison: "none",
    truncated: true,
  });
  expect(await readRepositoryFile(root, "empty", undefined, "file")).toEqual({
    kind: "text",
    text: "",
    view: "file",
    comparison: "none",
  });
});

test("shows a tracked file's deletion when a directory replaces it", async () => {
  const { root } = await fixture();
  await rm(join(root, "file.txt"));
  await mkdir(join(root, "file.txt"));
  await writeFile(join(root, "file.txt", "child.txt"), "new child\n");
  expect((await readRepositoryChanges(root)).changes).toContainEqual({
    path: "file.txt",
    previousPath: null,
    status: "deleted",
  });
  const file = await readRepositoryFile(root, "file.txt");
  expect(file.kind).toBe("text");
  if (file.kind !== "text") return;
  expect(file.view).toBe("diff");
  expect(file.deleted).toBe(true);
  expect(file.text).toContain("-first");
  expect(file.text).toContain("-last");
  expect(await readRepositoryFile(root, "file.txt", undefined, "file")).toEqual({
    kind: "unavailable",
    reason: "unsupported",
  });
  await mkdir(join(root, "ordinary-folder"));
  expect(await readRepositoryFile(root, "ordinary-folder")).toEqual({
    kind: "unavailable",
    reason: "unsupported",
  });
});

test("keeps hunk parsing correct when user Git configuration suppresses blank context markers", async () => {
  const { root, git } = await fixture();
  await writeFile(join(root, "file.txt"), "first\n\nlast\n");
  await git(["commit", "-am", "Blank fixture"]);
  await git(["config", "diff.suppressBlankEmpty", "true"]);
  await writeFile(join(root, "file.txt"), "first\n\nchanged\n");
  const file = await readRepositoryFile(root, "file.txt");
  expect(file.kind).toBe("text");
  if (file.kind !== "text") return;
  expect(
    prepareFileRows(file)
      .rows.filter((row) => row.kind === "lines" && row.changed && row.after !== null)
      .map((row) => (row.kind === "lines" ? [row.after?.text, row.after?.number] : null)),
  ).toEqual([["changed", 3]]);
});

test("handles deleted files, staged renames, untracked files and unborn HEAD", async () => {
  const { root, git } = await fixture();
  await git(["mv", "file.txt", "new.txt"]);
  const changes = await readRepositoryChanges(root);
  expect(changes.changes).toEqual([
    { path: "new.txt", previousPath: "file.txt", status: "renamed" },
  ]);
  const renamed = await readRepositoryFile(root, "new.txt", "file.txt");
  expect(renamed).toMatchObject({
    kind: "text",
    view: "file",
    text: "first\nlast\n",
    comparison: "head",
  });
  await writeFile(join(root, "new.txt"), "renamed content\n");
  const renamedChange = await readRepositoryFile(root, "new.txt", "file.txt");
  expect(renamedChange.kind === "text" && renamedChange.text).toContain("-first");
  expect(renamedChange.kind === "text" && renamedChange.text).toContain("+renamed content");
  await git(["reset", "--hard", "HEAD"]);
  await git(["rm", "file.txt"]);
  const deleted = await readRepositoryFile(root, "file.txt");
  expect(deleted.kind === "text" && deleted.text).toContain("-first");
  await writeFile(join(root, "untracked.txt"), "new\n");
  expect(await readRepositoryFile(root, "untracked.txt")).toEqual({
    kind: "text",
    text: "new\n",
    view: "file",
    comparison: "empty",
  });
  const unborn = await fixture(false);
  expect((await readRepositoryChanges(unborn.root)).head).toBeNull();
  expect(await readRepositoryFile(unborn.root, "file.txt")).toMatchObject({
    kind: "text",
    comparison: "unborn",
  });
});

test("rejects traversal, metadata, escaping parent symlinks, binary and special files", async () => {
  const { root } = await fixture();
  for (const path of [
    "../file",
    "/etc/passwd",
    "a/../b",
    ".git/config",
    ".GIT/config",
    "a\\b",
    "GIT~1/config",
    "a\nname",
  ]) {
    expect(repositoryPathSchema.safeParse(path).success).toBe(false);
    await expect(readRepositoryFile(root, path)).rejects.toThrow();
  }
  const outside = await mkdtemp(join(tmpdir(), "tidy-repository-outside-"));
  scratch.push(outside);
  await writeFile(join(outside, "secret.txt"), "outside fixture");
  await symlink(outside, join(root, "link"));
  expect(await readRepositoryFile(root, "link/secret.txt")).toEqual({
    kind: "unavailable",
    reason: "symlink",
  });
  await expect(readRepositoryDirectory(root, "link")).rejects.toThrow();
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 255]));
  expect(await readRepositoryFile(root, "binary")).toEqual({
    kind: "unavailable",
    reason: "binary",
  });
  await writeFile(join(root, "large"), Buffer.alloc(1024 * 1024 + 1));
  expect(await readRepositoryFile(root, "large")).toEqual({
    kind: "unavailable",
    reason: "oversized",
  });
});

test("keeps literal unusual filenames and honors ignore rules without hiding tracked ignored files", async () => {
  const { root, git } = await fixture();
  await writeFile(join(root, ".gitignore"), "ignored*\n");
  await writeFile(join(root, "ignored-tracked.txt"), "tracked\n");
  await git(["add", "-f", "ignored-tracked.txt"]);
  await git(["commit", "-m", "Tracked fixture"]);
  await writeFile(join(root, "ignored-secret.txt"), "ignored\n");
  await writeFile(join(root, ":(glob)*.txt"), "literal\n");
  await writeFile(join(root, "--option.txt"), "literal\n");
  const names = (await readRepositoryDirectory(root, "")).entries.map((entry) => entry.name);
  expect(names).toContain("ignored-tracked.txt");
  expect(names).not.toContain("ignored-secret.txt");
  expect(names).not.toContain(".git");
  for (const name of [":(glob)*.txt", "--option.txt"])
    expect(await readRepositoryFile(root, name)).toMatchObject({ kind: "text", text: "literal\n" });
});

test("scopes status and HEAD reads to a selected subdirectory", async () => {
  const { root, git } = await fixture();
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested/file.txt"), "old\n");
  await git(["add", "."]);
  await git(["commit", "-m", "Nested fixture"]);
  await writeFile(join(root, "nested/file.txt"), "new\n");
  await writeFile(join(root, "file.txt"), "outside selection\n");
  const changes = await readRepositoryChanges(join(root, "nested"));
  expect(changes.changes.map((change) => change.path)).toEqual(["file.txt"]);
  const file = await readRepositoryFile(join(root, "nested"), "file.txt");
  expect(file.kind === "text" && file.text).toContain("-old");
});

test("disables repository diff helpers", async () => {
  const { root, git } = await fixture();
  await git(["config", "diff.external", "false"]);
  await git(["config", "core.fsmonitor", "false"]);
  await writeFile(join(root, "file.txt"), "changed\n");
  expect((await readRepositoryChanges(root)).changes[0]?.status).toBe("modified");
  const file = await readRepositoryFile(root, "file.txt");
  expect(file.kind === "text" && file.text).toContain("+changed");
});

test("ignores inherited Git directory overrides and rejects a redirected working tree", async () => {
  const selected = await fixture();
  const other = await fixture();
  await writeFile(join(selected.root, "file.txt"), "selected change\n");
  await writeFile(join(other.root, "file.txt"), "other change\n");
  const module = new URL("./repository-files.ts", import.meta.url).href;
  const { stdout } = await execute(
    process.execPath,
    [
      "-e",
      `import { readRepositoryFile } from ${JSON.stringify(module)}; console.log(JSON.stringify(await readRepositoryFile(${JSON.stringify(selected.root)}, "file.txt")));`,
    ],
    {
      env: { ...process.env, GIT_DIR: join(other.root, ".git"), GIT_WORK_TREE: other.root },
    },
  );
  expect(stdout).toContain("selected change");
  expect(stdout).not.toContain("other change");
  await selected.git(["config", "core.worktree", other.root]);
  await expect(readRepositoryChanges(selected.root)).rejects.toThrow(
    "outside the selected project",
  );
  await expect(readRepositoryFile(selected.root, "file.txt")).rejects.toThrow(
    "outside the selected project",
  );
});

test("does not execute repository filters during status or diff reads", async () => {
  const { root, git } = await fixture();
  await writeFile(join(root, ".gitattributes"), "file.txt filter=fixture\n");
  await git(["config", "filter.fixture.clean", "touch filter-ran; cat"]);
  await git(["config", "filter.fixture.smudge", "touch filter-ran; cat"]);
  await git(["config", "filter.fixture.process", "touch filter-ran; cat"]);
  await writeFile(join(root, "file.txt"), "changed\n");
  expect((await readRepositoryChanges(root)).changes).toContainEqual({
    path: "file.txt",
    previousPath: null,
    status: "modified",
    filtered: true,
  });
  expect(await readRepositoryFile(root, "file.txt")).toEqual({
    kind: "unavailable",
    reason: "filtered",
  });
  await writeFile(join(root, "plain.txt"), "unfiltered\n");
  expect(await readRepositoryFile(root, "plain.txt")).toMatchObject({
    kind: "text",
    text: "unfiltered\n",
  });
  await expect(access(join(root, "filter-ran"))).rejects.toThrow();
});

test("shows conflict state instead of presenting an unresolved file as an ordinary diff", async () => {
  const { root, git } = await fixture();
  await git(["switch", "-c", "other"]);
  await writeFile(join(root, "file.txt"), "other\n");
  await git(["commit", "-am", "Other fixture"]);
  await git(["switch", "main"]);
  await writeFile(join(root, "file.txt"), "main\n");
  await git(["commit", "-am", "Main fixture"]);
  await git(["merge", "--no-commit", "other"]).catch(() => {});
  expect((await readRepositoryChanges(root)).changes[0]?.status).toBe("conflict");
  expect(await readRepositoryFile(root, "file.txt")).toEqual({
    kind: "unavailable",
    reason: "conflict",
  });
});

test("plain folders show file contents without claiming a Git addition", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tidy-local-files-")));
  scratch.push(root);
  await writeFile(join(root, "file.txt"), "local\n");
  expect(await readRepositoryChanges(root)).toEqual({ repository: false, head: null, changes: [] });
  expect(await readRepositoryFile(root, "file.txt")).toEqual({
    kind: "text",
    text: "local\n",
    view: "file",
    comparison: "none",
  });
});

test("directory observers coalesce file creation and stop delivering events after disposal", async () => {
  const { root } = await fixture();
  const events: string[] = [];
  const observers = new RepositoryObservers((projectId, path) =>
    events.push(`${projectId}:${path}`),
  );
  try {
    await observers.observe("fixture", root, "");
    await observers.observe("fixture", root, "");
    await writeFile(join(root, "first.txt"), "one\n");
    await writeFile(join(root, "second.txt"), "two\n");
    const deadline = Date.now() + 2000;
    while (!events.length && Date.now() < deadline) await Bun.sleep(20);
    expect(events).toEqual(["fixture:"]);
    observers.forget("fixture");
    await writeFile(join(root, "after-forget.txt"), "three\n");
    await Bun.sleep(150);
    expect(events).toHaveLength(1);
    observers.close();
    await observers.observe("fixture", root, "");
    await writeFile(join(root, "after-close.txt"), "four\n");
    await Bun.sleep(150);
    expect(events).toHaveLength(1);
  } finally {
    observers.close();
  }
});

test("preserves whitespace in selected subdirectory prefixes", async () => {
  const { root, git } = await fixture();
  await mkdir(join(root, " spaced"));
  await writeFile(join(root, " spaced/file.txt"), "before\n");
  await git(["add", "."]);
  await git(["commit", "-m", "Whitespace fixture"]);
  await writeFile(join(root, " spaced/file.txt"), "after\n");
  expect(
    (await readRepositoryChanges(join(root, " spaced"))).changes.map((change) => change.path),
  ).toEqual(["file.txt"]);
  const file = await readRepositoryFile(join(root, " spaced"), "file.txt");
  expect(file.kind === "text" && file.text).toContain("-before");
});

test("rejects a non-UTF-8 HEAD version rather than replacing its bytes in a text diff", async () => {
  const { root, git } = await fixture();
  await writeFile(join(root, "file.txt"), Buffer.from([0xff, 10]));
  await git(["commit", "-am", "Encoded baseline"]);
  await writeFile(join(root, "file.txt"), "valid UTF-8\n");
  expect(await readRepositoryFile(root, "file.txt")).toEqual({
    kind: "unavailable",
    reason: "binary",
  });
});

test("does not follow a replaced project root into a different directory", async () => {
  const { root } = await fixture();
  const selected = join(root, "selected"),
    outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "private.txt"), "outside fixture");
  await symlink(outside, selected);
  await expect(readRepositoryFile(selected, "private.txt")).rejects.toThrow();
  await expect(readRepositoryDirectory(selected, "")).rejects.toThrow();
  await expect(readRepositoryChanges(selected)).rejects.toThrow();
});

test("an opened repository file cannot be redirected by replacing its parent folder", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "nested"));
  await mkdir(join(root, "outside"));
  await writeFile(join(root, "nested/probe.txt"), "inside");
  await writeFile(join(root, "outside/probe.txt"), "outside fixture");
  const opened = await openRepositoryPath(root, "nested/probe.txt");
  try {
    await rename(join(root, "nested"), join(root, "held"));
    await symlink(join(root, "outside"), join(root, "nested"));
    expect((await opened.file.readFile()).toString("utf8")).toBe("inside");
  } finally {
    await opened.file.close();
  }
});

test("respects checkout line endings without manufacturing changes", async () => {
  const { root, git } = await fixture();
  await git(["config", "core.autocrlf", "false"]);
  await writeFile(join(root, ".gitattributes"), "file.txt text eol=crlf\n");
  await git(["add", ".gitattributes"]);
  await git(["commit", "-m", "Line ending fixture"]);
  await writeFile(join(root, "file.txt"), "first\r\nlast\r\n");
  await git(["add", "file.txt"]);
  expect((await readRepositoryChanges(root)).changes).toEqual([]);
  expect(await readRepositoryFile(root, "file.txt")).toMatchObject({ kind: "text", view: "file" });
  await writeFile(join(root, "file.txt"), "first\r\nchanged\r\n");
  const file = await readRepositoryFile(root, "file.txt");
  if (file.kind !== "text") throw new Error("Expected a text diff.");
  const rows = prepareFileRows(file);
  expect(rows.removed).toBe(1);
  expect(rows.added).toBe(1);
});

test("bounds deleted HEAD blobs before preparing a preview", async () => {
  const { root, git } = await fixture();
  await writeFile(join(root, "file.txt"), Buffer.alloc(1024 * 1024 + 1, 97));
  await git(["commit", "-am", "Large baseline fixture"]);
  await git(["rm", "file.txt"]);
  expect(await readRepositoryFile(root, "file.txt")).toEqual({
    kind: "unavailable",
    reason: "oversized",
  });
});

test("does not claim a diff for content transformed by an external Git filter", async () => {
  const { root, git } = await fixture();
  await writeFile(join(root, ".gitattributes"), "file.txt filter=fixture\n");
  await git(["config", "filter.fixture.clean", "sed s/expanded/first/"]);
  await writeFile(join(root, "file.txt"), "expanded\nlast\n");
  await git(["add", "."]);
  await git(["commit", "-m", "Filtered fixture"]);
  expect((await git(["status", "--porcelain"])).stdout).toBe("");
  await git(["config", "filter.fixture.clean", "touch filter-ran; sed s/expanded/first/"]);
  expect((await readRepositoryChanges(root)).changes).toContainEqual({
    path: "file.txt",
    previousPath: null,
    status: "modified",
    filtered: true,
  });
  expect(await readRepositoryFile(root, "file.txt")).toEqual({
    kind: "unavailable",
    reason: "filtered",
  });
  await expect(access(join(root, "filter-ran"))).rejects.toThrow();
});

test("compares captured bytes without applying unrelated attributes to scratch files", async () => {
  const { root, git } = await fixture();
  await git(["config", "core.autocrlf", "true"]);
  await writeFile(join(root, ".gitattributes"), "file.txt -text\n");
  await writeFile(join(root, "global-attributes"), "* text\n");
  await writeFile(join(root, ".git/info/attributes"), "after text\n");
  await git(["config", "core.attributesFile", join(root, "global-attributes")]);
  await git(["add", ".gitattributes", "global-attributes"]);
  await git(["commit", "-m", "Attribute isolation fixture"]);
  await writeFile(join(root, "file.txt"), "first\r\nlast\r\n");
  expect((await git(["diff", "HEAD", "--", "file.txt"])).stdout).toContain("@@");
  const file = await readRepositoryFile(root, "file.txt");
  expect(file.kind === "text" && file.view).toBe("diff");
});

test("does not fetch missing partial-clone blobs or execute their transport", async () => {
  const { root, git } = await fixture();
  const oid = (await git(["rev-parse", "HEAD:file.txt"])).stdout.trim();
  const remote = join(root, "remote.git");
  await git(["clone", "--bare", root, remote]);
  const object = join(root, ".git", "objects", oid.slice(0, 2), oid.slice(2));
  await rm(object);
  await git(["config", "remote.origin.url", remote]);
  await git(["config", "remote.origin.promisor", "true"]);
  await git(["config", "remote.origin.partialclonefilter", "blob:none"]);
  await git(["config", "remote.origin.uploadpack", "touch helper-ran; git-upload-pack"]);
  await writeFile(join(root, "file.txt"), "changed\n");
  await expect(readRepositoryFile(root, "file.txt")).rejects.toThrow("unavailable locally");
  await expect(access(join(root, "helper-ran"))).rejects.toThrow();
  await expect(access(object)).rejects.toThrow();
});

test("reports unsupported filters even when raw working bytes equal HEAD", async () => {
  const { root, git } = await fixture();
  await writeFile(join(root, ".gitattributes"), "file.txt filter=fixture\n");
  await git(["add", ".gitattributes"]);
  await git(["commit", "-m", "Fixture attributes"]);
  await git(["config", "filter.fixture.clean", "sed s/first/transformed/"]);
  await writeFile(join(root, "file.txt"), "intermediate\n");
  await writeFile(join(root, "file.txt"), "first\nlast\n");
  expect((await git(["status", "--porcelain"])).stdout).toContain(" M file.txt");
  expect((await readRepositoryChanges(root)).changes).toContainEqual({
    path: "file.txt",
    previousPath: null,
    status: "modified",
    filtered: true,
  });
});

test("global filters leave ordinary changes usable and only flag affected tracked paths", async () => {
  const { root, git } = await fixture();
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "assets/filtered.txt"), "stored\n");
  await writeFile(join(root, "assets/plain.txt"), "plain\n");
  await writeFile(
    join(root, ".gitattributes"),
    "assets/filtered.txt filter=fixture\nassets/plain.txt -filter\n",
  );
  await git(["add", "."]);
  await git(["commit", "-m", "Fixture assets"]);
  await writeFile(join(root, "file.txt"), "ordinary change\n");
  const home = await mkdtemp(join(tmpdir(), "tidy-filter-home-"));
  scratch.push(home);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await git(["config", "--global", "filter.fixture.clean", "touch filter-ran; cat"]);
    expect((await readRepositoryChanges(root)).changes).toEqual([
      { path: "file.txt", previousPath: null, status: "modified" },
      { path: "assets/filtered.txt", previousPath: null, status: "modified", filtered: true },
    ]);
    expect((await readRepositoryChanges(join(root, "assets"))).changes).toEqual([
      { path: "filtered.txt", previousPath: null, status: "modified", filtered: true },
    ]);
    expect(await readRepositoryFile(root, "file.txt")).toMatchObject({
      kind: "text",
      view: "diff",
    });
    expect(await readRepositoryFile(root, "assets/filtered.txt")).toEqual({
      kind: "unavailable",
      reason: "filtered",
    });
    await expect(access(join(root, "filter-ran"))).rejects.toThrow();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("represents a deleted and recreated tracked path once as a modification", async () => {
  const { root, git } = await fixture();
  await git(["rm", "file.txt"]);
  await writeFile(join(root, "file.txt"), "replacement\n");
  await writeFile(join(root, "next.txt"), "next\n");
  const changes = await readRepositoryChanges(root);
  expect(changes.changes).toEqual([
    { path: "file.txt", previousPath: null, status: "modified" },
    { path: "next.txt", previousPath: null, status: "untracked" },
  ]);
  const preview = await readRepositoryFile(root, "file.txt");
  expect(preview.kind === "text" && preview.text).toContain("-first");
  expect(preview.kind === "text" && preview.text).toContain("+replacement");
});

test("reads renamed HEAD content when the old path has become a symlink", async () => {
  const { root, git } = await fixture();
  await git(["mv", "file.txt", "new.txt"]);
  await symlink("new.txt", join(root, "file.txt"));
  expect(await readRepositoryFile(root, "new.txt", "file.txt")).toMatchObject({
    kind: "text",
    text: "first\nlast\n",
    comparison: "head",
  });
  await expect(readRepositoryFile(root, "new.txt", "../outside")).rejects.toThrow();
});

test("distinguishes deletion of an empty tracked file from unchanged content", async () => {
  const { root, git } = await fixture();
  await writeFile(join(root, "empty.txt"), "");
  await git(["add", "empty.txt"]);
  await git(["commit", "-m", "Empty fixture"]);
  await rm(join(root, "empty.txt"));
  expect(await readRepositoryFile(root, "empty.txt")).toEqual({
    kind: "text",
    text: "",
    view: "diff",
    comparison: "head",
    deleted: true,
  });
});

test.each(["status", "preview"] as const)(
  "isolates %s from concurrently added Git filters",
  async (operation) => {
    const { root, git } = await fixture();
    await writeFile(join(root, ".gitattributes"), "file.txt filter=late\n");
    await git(["add", ".gitattributes"]);
    await git(["commit", "-m", "Fixture attributes"]);
    await writeFile(join(root, "file.txt"), "other\nlast\n");
    const bin = join(root, "tools");
    await mkdir(bin);
    const executable = Bun.which("git");
    if (!executable) throw new Error("Git is required.");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const marker = join(root, "helper-ran");
    const driver = `touch ${quote(marker)}; cat`;
    const trigger = operation === "status" ? "status" : "--filters";
    const key = operation === "status" ? "filter.late.clean" : "filter.late.smudge";
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\nfor arg in "$@"; do\nif [ "$arg" = ${quote(trigger)} ]; then\n${quote(executable)} -C ${quote(root)} config ${quote(key)} ${quote(driver)}\nfi\ndone\nexec ${quote(executable)} "$@"\n`,
    );
    await chmod(join(bin, "git"), 0o700);
    const before = process.env.PATH;
    process.env.PATH = `${bin}:${before ?? ""}`;
    try {
      if (operation === "status") {
        expect((await readRepositoryChanges(root)).changes).toContainEqual({
          path: "file.txt",
          previousPath: null,
          status: "modified",
        });
      } else {
        const file = await readRepositoryFile(root, "file.txt");
        expect(file.kind === "text" && file.text).toContain("+other");
      }
      await expect(access(marker)).rejects.toThrow();
    } finally {
      if (before === undefined) delete process.env.PATH;
      else process.env.PATH = before;
    }
  },
);

test.each([
  "sha256",
  "split",
  "split-sha256",
  "worktree",
  "split-worktree",
  "nested",
  "sparse",
] as const)("preserves %s repository status and index state", async (kind) => {
  const { root, git } = await fixture(true, kind.endsWith("sha256") ? "sha256" : "sha1");
  let selected = root;
  if (kind.endsWith("worktree")) {
    selected = join(root, "linked");
    await git(["worktree", "add", "-b", "fixture-linked", selected]);
  }
  if (kind === "nested" || kind === "sparse") {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested/inside.txt"), "baseline\n");
    await git(["add", "."]);
    await git(["commit", "-m", "Nested fixture"]);
    if (kind === "nested") selected = join(root, "nested");
    else {
      await git(["sparse-checkout", "init", "--cone", "--sparse-index"]);
      await git(["sparse-checkout", "set", "nested"]);
    }
  }
  const run = (args: string[]) => execute("git", args, { cwd: selected, env: gitEnvironment() });
  if (kind.startsWith("split")) {
    await run(["update-index", "--split-index"]);
    await run(["config", "filter.fixture.clean", "cat"]);
  }
  const path =
    kind === "nested" ? "inside.txt" : kind === "sparse" ? "nested/inside.txt" : "file.txt";
  await writeFile(join(selected, path), "modified\n");
  const index = (
    await run(["rev-parse", "--path-format=absolute", "--git-path", "index"])
  ).stdout.trim();
  const before = await readFile(index);
  const shared = kind.startsWith("split")
    ? resolve(selected, (await run(["rev-parse", "--shared-index-path"])).stdout.trim())
    : null;
  if (shared) await utimes(shared, 946684800, 946684800);
  const mtime = shared ? (await stat(shared)).mtimeMs : null;
  const sharedBefore = shared ? await readFile(shared) : null;
  expect(
    (await readRepositoryDirectory(selected, "")).entries.some(
      (entry) => entry.path === path.split("/")[0],
    ),
  ).toBe(true);
  expect((await readRepositoryChanges(selected)).changes).toContainEqual({
    path,
    previousPath: null,
    status: "modified",
  });
  if (shared && mtime !== null) expect((await stat(shared)).mtimeMs).toBe(mtime);
  const file = await readRepositoryFile(selected, path);
  expect(file.kind === "text" && file.text).toContain("+modified");
  expect(await readFile(index)).toEqual(before);
  if (shared && mtime !== null && sharedBefore !== null) {
    expect((await stat(shared)).mtimeMs).toBe(mtime);
    expect(await readFile(shared)).toEqual(sharedBefore);
  }
});

test("detects same-size changes with racy index timestamps", async () => {
  const { root, git } = await fixture();
  await git(["config", "core.trustctime", "false"]);
  await git(["config", "core.checkstat", "minimal"]);
  const path = join(root, "file.txt");
  await utimes(path, 946684800, 946684800);
  await git(["add", "file.txt"]);
  await writeFile(path, "other\nlast\n");
  await utimes(path, 946684800, 946684800);
  await utimes(join(root, ".git/index"), 946684800, 946684800);
  expect((await git(["diff", "--name-only"])).stdout.trim()).toBe("file.txt");
  expect((await readRepositoryChanges(root)).changes).toContainEqual({
    path: "file.txt",
    previousPath: null,
    status: "modified",
  });
});

test("shares concurrent index snapshots, refreshes configuration, and retains leased revisions", async () => {
  const { root, git } = await fixture();
  const views = await Promise.all(Array.from({ length: 4 }, () => createGitView(root)));
  try {
    expect(new Set(views.map((view) => view.index)).size).toBe(1);
    const original = views[0].index;
    await git(["config", "core.ignorecase", "true"]);
    const configured = await createGitView(root);
    views.push(configured);
    expect(configured.index).toBe(original);
    expect(await readFile(join(configured.directory, "config"), "utf8")).toContain(
      'ignorecase="true"',
    );
    await writeFile(join(root, "file.txt"), "staged\n");
    await git(["add", "file.txt"]);
    const updated = await createGitView(root);
    views.push(updated);
    expect(updated.index).not.toBe(original);
    await access(original);
    await Promise.all(views.splice(0, 5).map(closeGitView));
    await expect(access(original)).rejects.toThrow();
    expect((await readRepositoryChanges(root)).changes).toContainEqual({
      path: "file.txt",
      previousPath: null,
      status: "modified",
    });
  } finally {
    await Promise.all(views.map(closeGitView));
  }
  await closeGitSnapshots();
  await expect(access(views[0].index)).rejects.toThrow();
});

test("keeps folder browsing available when the Git index exceeds the snapshot limit", async () => {
  const { root } = await fixture();
  await truncate(join(root, ".git/index"), 64 * 1024 * 1024 + 1);
  const directory = await readRepositoryDirectory(root, "");
  expect(directory.ignoreUnavailable).toBe(true);
  expect(directory.entries).toContainEqual({ path: "file.txt", name: "file.txt", kind: "file" });
});

test.each(["missing-git", "broken-config", "broken-index"] as const)(
  "keeps bounded folder browsing available with %s",
  async (failure) => {
    const { root } = await fixture();
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "ordinary fixture\n");
    if (failure === "broken-config")
      await writeFile(join(root, ".git/config"), "[invalid configuration\n");
    if (failure === "broken-index") await writeFile(join(root, ".git/index"), "invalid index\n");
    const previousPath = process.env.PATH;
    try {
      if (failure === "missing-git") process.env.PATH = root;
      const directory = await readRepositoryDirectory(root, "");
      expect(directory.entries).toContainEqual({
        path: "file.txt",
        name: "file.txt",
        kind: "file",
      });
      expect(directory.entries.some((entry) => entry.name === ".git")).toBe(false);
      expect(directory.entries.length).toBeLessThanOrEqual(5000);
      expect(directory.ignoreUnavailable).toBe(true);
      await expect(readRepositoryDirectory(root, "../outside")).rejects.toThrow();
      await expect(readRepositoryDirectory(root, ".git")).rejects.toThrow();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
);

test("reports broken Git configuration and recovers after it is repaired", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "file.txt"), "modified\n");
  const config = await readFile(join(root, ".git/config"));
  await writeFile(join(root, ".git/config"), "[invalid configuration\n");
  await expect(readRepositoryChanges(root)).rejects.toThrow("Check its configuration");
  expect(await readRepositoryFile(root, "file.txt", undefined, "file")).toEqual({
    kind: "text",
    text: "modified\n",
    view: "file",
    comparison: "none",
  });
  await writeFile(join(root, ".git/config"), config);
  expect((await readRepositoryChanges(root)).changes).toContainEqual({
    path: "file.txt",
    previousPath: null,
    status: "modified",
  });
});

test.each(["rev-parse", "check-ignore"])(
  "cancels stalled optional %s inspection",
  async (command) => {
    const { root } = await fixture();
    const bin = join(root, "bin");
    await mkdir(bin);
    const executable = Bun.which("git");
    if (!executable) throw new Error("Git is required.");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const pidFile = join(root, "git-process");
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\nfor arg in "$@"; do\nif [ "$arg" = ${quote(command)} ]; then\necho $$ > ${quote(pidFile)}\nexec /bin/sleep 30\nfi\ndone\nexec ${quote(executable)} "$@"\n`,
    );
    await chmod(join(bin, "git"), 0o700);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = bin;
      const directory = await readRepositoryDirectory(root, "");
      expect(directory.ignoreUnavailable).toBe(true);
      expect(directory.entries).toContainEqual({
        path: "file.txt",
        name: "file.txt",
        kind: "file",
      });
      const pid = Number(await readFile(pidFile, "utf8"));
      await expect(async () => {
        for (let attempt = 0; attempt < 50; attempt++) {
          try {
            process.kill(pid, 0);
          } catch {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Optional Git inspection was not cancelled.");
      }).not.toThrow();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
  2000,
);

test.each(["count", "payload"] as const)(
  "retains ordinary changes when filtered paths exceed the %s budget",
  async (budget) => {
    const { root, git } = await fixture();
    await writeFile(join(root, ".gitattributes"), "*.asset filter=fixture\n");
    await git(["add", ".gitattributes"]);
    await git(["commit", "-m", "Fixture attributes"]);
    await git(["config", "filter.fixture.clean", "cat"]);
    const blob = (await git(["rev-parse", "HEAD:file.txt"])).stdout.trim();
    const paths = Array.from(
      { length: 20001 },
      (_, index) => `${budget === "payload" ? "x".repeat(220) : "asset"}-${index}.asset`,
    );
    const input = join(root, ".git/fixture-input");
    async function runInput(args: string[], text: string) {
      await writeFile(input, text);
      const child = Bun.spawn(["git", ...args], {
        cwd: root,
        env: gitEnvironment(),
        stdin: Bun.file(input),
        stdout: "ignore",
        stderr: "pipe",
      });
      const error = await new Response(child.stderr).text();
      expect(await child.exited, error).toBe(0);
    }
    await runInput(
      ["update-index", "--index-info"],
      paths.map((path) => `100644 ${blob}\t${path}\n`).join(""),
    );
    await runInput(["update-index", "--skip-worktree", "--stdin"], paths.join("\n") + "\n");
    await git(["commit", "--quiet", "-m", "Fixture asset index"]);
    await writeFile(join(root, "file.txt"), "modified\n");
    expect((await git(["status", "--porcelain", "--untracked-files=all"])).stdout).toBe(
      " M file.txt\n",
    );
    const result = await readRepositoryChanges(root);
    expect(result.limited).toBe(true);
    expect(result.changes.length).toBeLessThanOrEqual(20000);
    expect(result.changes).toContainEqual({
      path: "file.txt",
      previousPath: null,
      status: "modified",
    });
  },
);

test("preserves configured attribute and ignore paths in the private Git view", async () => {
  const { root, git } = await fixture();
  const settings = join(root, 'local "settings"');
  await mkdir(settings);
  await writeFile(join(settings, "attributes"), "file.txt text eol=crlf\n");
  await writeFile(join(settings, "ignore"), "ignored.tmp\nlocal*/\n");
  await git(["config", "core.attributesFile", join(settings, "attributes")]);
  await git(["config", "core.excludesFile", join(settings, "ignore")]);
  await writeFile(join(root, "ignored.tmp"), "ignored\n");
  await writeFile(join(root, "file.txt"), "first\r\nlast\r\n");
  await git(["add", "file.txt"]);
  expect((await readRepositoryChanges(root)).changes).toEqual([]);
  expect(await readRepositoryFile(root, "file.txt")).toMatchObject({
    kind: "text",
    view: "file",
    comparison: "head",
  });
});

test("rejects special Git metadata without waiting for a pipe writer", async () => {
  const { root } = await fixture();
  await execute("mkfifo", [join(root, ".git/info/attributes")]);
  await expect(readRepositoryChanges(root)).rejects.toThrow("Git metadata");
});

test("rejects Git results when the selected root is replaced during status", async () => {
  const { root } = await fixture();
  const bin = await realpath(await mkdtemp(join(tmpdir(), "tidy-repository-root-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "tidy-repository-outside-")));
  scratch.push(bin, outside);
  const held = join(bin, "held-project");
  const executable = Bun.which("git");
  if (!executable) throw new Error("Git is required for repository tests.");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(join(outside, "outside-name.txt"), "outside\n");
  await symlink(join(held, ".git"), join(outside, ".git"));
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\nfor arg in "$@"; do\nif [ "$arg" = status ]; then\nmv ${quote(root)} ${quote(held)}\nln -s ${quote(outside)} ${quote(root)}\nbreak\nfi\ndone\nexec ${quote(executable)} "$@"\n`,
    { mode: 0o700 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  try {
    await expect(readRepositoryChanges(root)).rejects.toThrow("project directory");
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(root, { force: true });
    await rename(held, root);
  }
});

test("fixture Git commands ignore inherited repository and index locations", async () => {
  const other = await fixture();
  const before = await readFile(join(other.root, ".git/index"));
  const overrides = {
    GIT_DIR: join(other.root, ".git"),
    GIT_WORK_TREE: other.root,
    GIT_INDEX_FILE: join(other.root, ".git/index"),
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const selected = await fixture();
    expect((await selected.git(["rev-parse", "--show-toplevel"])).stdout.trim()).toBe(
      selected.root,
    );
    expect(await readFile(join(other.root, ".git/index"))).toEqual(before);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("native Node runtime supports directory listing and Git previews", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested/new.txt"), "new file\n");
  await symlink("nested", join(root, "alias"));
  await writeFile(join(root, "file.txt"), "changed\nlast\n");
  const module = pathToFileURL(join(import.meta.dirname, "repository-files.ts")).href;
  const script = `
    const { readRepositoryDirectory, readRepositoryChanges, readRepositoryFile } = await import(${JSON.stringify(module)});
    const { closeGitSnapshots } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "repository-git.ts")).href)});
    const root = ${JSON.stringify(root)};
    const directory = await readRepositoryDirectory(root, "alias");
    const changes = await readRepositoryChanges(root);
    const file = await readRepositoryFile(root, "file.txt");
    const alias = await readRepositoryFile(root, "alias/new.txt", undefined, "file");
    await closeGitSnapshots();
    console.log(JSON.stringify({ directory, changes, file, alias }));
  `;
  const index = await readFile(join(root, ".git/index"));
  const result = await execute(
    "node",
    ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", script],
    { env: gitEnvironment() },
  );
  expect(await readFile(join(root, ".git/index"))).toEqual(index);
  const value = z
    .object({
      directory: repositoryDirectorySchema,
      changes: repositoryChangesSchema,
      file: repositoryFileSchema,
      alias: repositoryFileSchema,
    })
    .parse(JSON.parse(result.stdout));
  expect(value.directory.entries).toContainEqual({
    path: "alias/new.txt",
    name: "new.txt",
    kind: "file",
  });
  expect(value.changes.changes).toContainEqual({
    path: "file.txt",
    previousPath: null,
    status: "modified",
  });
  expect(value.alias).toEqual({
    kind: "text",
    text: "new file\n",
    view: "file",
    comparison: "none",
  });
  expect(value.file).toMatchObject({ kind: "text", view: "diff" });
  expect(value.file.kind === "text" && value.file.text).toContain("+changed");
});

test.each(["file", "directory"] as const)(
  "%s identity validation rejects replacements and symlink aliases",
  async (kind) => {
    const { root } = await fixture();
    const create = () =>
      kind === "directory"
        ? mkdir(join(root, "nested"))
        : writeFile(join(root, "nested"), "preview content");
    await create();
    const opened = await openRepositoryPath(root, "nested", kind === "directory");
    try {
      await assertRepositoryPathStable(opened);
      await rename(join(root, "nested"), join(root, "held"));
      await create();
      await expect(assertRepositoryPathStable(opened)).rejects.toThrow("project directory");
      await rm(join(root, "nested"), { recursive: true });
      await symlink(join(root, "held"), join(root, "nested"));
      await expect(assertRepositoryPathStable(opened)).rejects.toThrow("project directory");
    } finally {
      await opened.file.close();
    }
  },
);

test("browses confined file and directory links while keeping unsafe links unavailable", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source/note.txt"), "linked content");
  await writeFile(join(root, "source/ignored.txt"), "ignored");
  await writeFile(join(root, ".gitignore"), "source/ignored.txt\n");
  await symlink("source", join(root, "alias"));
  await symlink("alias/note.txt", join(root, "note.txt"));
  await symlink(".git/config", join(root, "metadata"));
  await symlink("missing.txt", join(root, "dangling"));
  await symlink("cycle", join(root, "cycle"));
  const listing = await readRepositoryDirectory(root, "");
  for (const [name, kind] of [
    ["alias", "directory"],
    ["note.txt", "file"],
    ["metadata", "symlink"],
    ["dangling", "symlink"],
    ["cycle", "symlink"],
  ] as const)
    expect(listing.entries).toContainEqual({ name, path: name, kind });
  const aliasedDirectory = await readRepositoryDirectory(root, "alias");
  expect(aliasedDirectory.ignoreUnavailable).toBeUndefined();
  expect(aliasedDirectory.entries.map((entry) => entry.name)).toEqual(["note.txt"]);
  expect(aliasedDirectory.entries).toContainEqual({
    name: "note.txt",
    path: "alias/note.txt",
    kind: "file",
  });
  expect(await readRepositoryFile(root, "note.txt", undefined, "file")).toEqual({
    kind: "text",
    text: "linked content",
    view: "file",
    comparison: "none",
  });
  expect(await readRepositoryFile(root, "note.txt")).toEqual({
    kind: "unavailable",
    reason: "unsupported",
  });
  for (const path of ["metadata", "dangling", "cycle"])
    expect(await readRepositoryFile(root, path, undefined, "file")).toEqual({
      kind: "unavailable",
      reason: "symlink",
    });
  const opened = await openRepositoryPath(root, "note.txt");
  try {
    await rm(join(root, "alias"));
    await symlink(".", join(root, "alias"));
    await expect(assertRepositoryPathStable(opened)).rejects.toThrow();
  } finally {
    await opened.file.close();
  }
});

test("truncates text previews at a complete UTF-8 character without presenting partial diffs", async () => {
  const { root } = await fixture();
  const prefix = "x".repeat(1024 * 1024 - 1);
  await writeFile(join(root, "large.txt"), prefix + "€tail");
  expect(await readRepositoryFile(root, "large.txt", undefined, "file")).toEqual({
    kind: "text",
    text: prefix,
    view: "file",
    comparison: "none",
    truncated: true,
  });
  expect(await readRepositoryFile(root, "large.txt")).toEqual({
    kind: "unavailable",
    reason: "oversized",
  });
  await writeFile(join(root, "large.txt"), "x".repeat(1024 * 1024));
  const complete = await readRepositoryFile(root, "large.txt", undefined, "file");
  expect(complete.kind === "text" && complete.truncated).toBeUndefined();
  await writeFile(join(root, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 0x80));
  expect(await readRepositoryFile(root, "large.txt", undefined, "file")).toEqual({
    kind: "unavailable",
    reason: "binary",
  });
});
