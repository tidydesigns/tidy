import { afterEach, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as repositoryGit from "./repository-git";
import * as repositoryPath from "./repository-path";
import { searchRepositoryFiles } from "./repository-search";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tidy-search-")));
  directories.push(root);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  return {
    root,
    git: (...args: string[]) =>
      execute("git", args, {
        cwd: root,
        env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      }),
    async file(path: string) {
      const parts = path.split("/");
      parts.pop();
      await mkdir(join(root, ...parts), { recursive: true });
      await writeFile(join(root, path), "fixture\n");
    },
  };
}

test("searches unopened Git folders, preserves tracked ignored files, and confines results", async () => {
  const f = await fixture();
  await f.git("init");
  await f.file("nested/deeper/Needle.ts");
  await f.git("add", ".");
  await f.file("unopened/needle.txt");
  await f.file("ignored/needle.txt");
  await f.file("node_modules/package/needle.js");
  await writeFile(join(f.root, ".gitignore"), "nested/\nignored/\n");
  const outside = await fixture();
  await outside.file("needle-secret.txt");
  await symlink(join(outside.root, "needle-secret.txt"), join(f.root, "needle-link.txt"));
  expect(
    (await searchRepositoryFiles(f.root, "NEEDLE")).entries.map((entry) => entry.path).sort(),
  ).toEqual(["nested/deeper/Needle.ts", "unopened/needle.txt"]);
  expect(
    (await searchRepositoryFiles(join(f.root, "nested"), "needle")).entries.map(
      (entry) => entry.path,
    ),
  ).toEqual(["deeper/Needle.ts"]);
});

test("searches plain folders without traversing dependency folders or external symlinks", async () => {
  const f = await fixture();
  await f.file("unopened/deeper/needle.txt");
  await f.file("node_modules/needle.js");
  const outside = await fixture();
  await outside.file("needle-secret.txt");
  await symlink(outside.root, join(f.root, "external"));
  expect(await searchRepositoryFiles(f.root, "needle")).toEqual({
    entries: [{ path: "unopened/deeper/needle.txt", name: "needle.txt", kind: "file" }],
    limited: false,
  });
});

test("bounds search results and validates queries", async () => {
  const f = await fixture();
  await f.git("init");
  await Promise.all(Array.from({ length: 502 }, (_, index) => f.file(`needle-${index}.txt`)));
  const result = await searchRepositoryFiles(f.root, "needle");
  expect(result.entries).toHaveLength(500);
  expect(result.limited).toBe(true);
  await expect(searchRepositoryFiles(f.root, " ")).rejects.toThrow();
  await expect(searchRepositoryFiles(f.root, "x".repeat(257))).rejects.toThrow();
});

test("shares in-flight inventories and refreshes after filesystem changes", async () => {
  const f = await fixture();
  await f.git("init");
  await f.file("unopened/first.txt");
  await f.file("unopened/second.txt");
  const commands = spyOn(repositoryGit, "git");
  try {
    const [first, second] = await Promise.all([
      searchRepositoryFiles(f.root, "first"),
      searchRepositoryFiles(f.root, "second"),
    ]);
    expect(first.entries.map((entry) => entry.path)).toEqual(["unopened/first.txt"]);
    expect(second.entries.map((entry) => entry.path)).toEqual(["unopened/second.txt"]);
    expect(commands).toHaveBeenCalledTimes(2);
    await f.file("unopened/new.txt");
    expect((await searchRepositoryFiles(f.root, "new")).entries.map((entry) => entry.path)).toEqual(
      ["unopened/new.txt"],
    );
  } finally {
    commands.mockRestore();
  }
});

test("bounds validation when tracked matches no longer exist", async () => {
  const f = await fixture();
  await f.git("init");
  await Promise.all(
    Array.from({ length: 2001 }, (_, index) => f.file(`removed/needle-${index}.txt`)),
  );
  await f.git("add", ".");
  await rm(join(f.root, "removed"), { recursive: true });
  expect(await searchRepositoryFiles(f.root, "needle")).toEqual({ entries: [], limited: true });
});

test("skips tracked files whose parent has become a file", async () => {
  const f = await fixture();
  await f.git("init");
  await f.file("removed/needle.txt");
  await f.file("needle-valid.txt");
  await f.git("add", ".");
  await rm(join(f.root, "removed"), { recursive: true });
  await writeFile(join(f.root, "removed"), "replacement\n");
  expect(await searchRepositoryFiles(f.root, "needle")).toEqual({
    entries: [{ path: "needle-valid.txt", name: "needle-valid.txt", kind: "file" }],
    limited: false,
  });
});

test("skips a candidate replaced during validation without hiding unexpected failures", async () => {
  const f = await fixture();
  await f.git("init");
  await f.file("needle-replaced.txt");
  await f.file("needle-valid.txt");
  const open = repositoryPath.openRepositoryPath;
  let failure = "The project directory moved. Open it again.";
  const paths = spyOn(repositoryPath, "openRepositoryPath").mockImplementation(
    (root, path, directory) => {
      if (path === "needle-replaced.txt") return Promise.reject(new Error(failure));
      return open(root, path, directory);
    },
  );
  try {
    expect(await searchRepositoryFiles(f.root, "needle")).toEqual({
      entries: [{ path: "needle-valid.txt", name: "needle-valid.txt", kind: "file" }],
      limited: false,
    });
    failure = "Unexpected filesystem failure";
    await expect(searchRepositoryFiles(f.root, "needle")).rejects.toThrow(failure);
  } finally {
    paths.mockRestore();
  }
});
