import { isUtf8 } from "node:buffer";
import { watch, type FSWatcher } from "node:fs";
import { lstat, opendir, realpath, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { checkedRepositoryPath as checkedPath, openRepositoryPath } from "./repository-path";
import { git, createGitView, closeGitView, OutputLimitError } from "./repository-git";
import {
  repositoryPathSchema,
  type RepositoryChanges,
  type RepositoryChange,
  type RepositoryDirectory,
  type RepositoryFile,
} from "../../shared/contracts/repository-files";

const fileLimit = 1024 * 1024;
const diffLimit = 2 * fileLimit;
export class RepositoryObservers {
  private closed = false;
  private entries = new Map<
    string,
    {
      watcher: FSWatcher;
      expiry: ReturnType<typeof setTimeout>;
      notification?: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private notify: (projectId: string, path: string) => void) {}
  async observe(projectId: string, root: string, path: string) {
    if (this.closed) return;
    const key = `${projectId}:${path}`;
    const previous = this.entries.get(key);
    if (previous) {
      clearTimeout(previous.expiry);
      previous.expiry = setTimeout(() => this.remove(key), 45000).unref();
      return;
    }
    const checked = await checkedPath(root, path);
    if (this.closed || this.entries.has(key)) return;
    try {
      const watcher = watch(checked.target, { persistent: false }, () => {
        const entry = this.entries.get(key);
        if (!entry) return;
        if (entry.notification) return;
        entry.notification = setTimeout(() => {
          entry.notification = undefined;
          this.notify(projectId, path);
        }, 100).unref();
      });
      watcher.on("error", () => this.remove(key));
      this.entries.set(key, { watcher, expiry: setTimeout(() => this.remove(key), 45000).unref() });
      while (this.entries.size > 128) {
        const first = this.entries.keys().next().value;
        if (first === undefined) break;
        this.remove(first);
      }
    } catch {}
  }
  private remove(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.watcher.close();
    clearTimeout(entry.expiry);
    clearTimeout(entry.notification);
    this.entries.delete(key);
  }
  forget(projectId: string) {
    for (const key of this.entries.keys()) if (key.startsWith(`${projectId}:`)) this.remove(key);
  }
  close() {
    this.closed = true;
    for (const key of this.entries.keys()) this.remove(key);
  }
}

async function filterOverrides(root: string) {
  const filters = await git(root, [
    "config",
    "--name-only",
    "--get-regexp",
    "^filter\\..*\\.(clean|smudge|process|required)$",
  ]);
  if (![0, 1].includes(filters.code))
    throw new Error("Could not read repository filter configuration.");
  const keys = filters.text.split("\n").filter(Boolean);
  if (keys.some((key) => !/^filter\.[^\x00-\x20=]+\.(clean|smudge|process|required)$/i.test(key)))
    throw new Error("This repository's filter configuration cannot be safely previewed.");
  return {
    args: keys.flatMap((key) => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]),
    names: new Set(
      keys
        .filter((key) => !key.endsWith(".required"))
        .map((key) => key.slice(7, key.lastIndexOf("."))),
    ),
  };
}

async function externalFilteredPaths(root: string, paths: string[], filters: ReadonlySet<string>) {
  if (!filters.size || !paths.length) return new Set<string>();
  const result = await git(
    root,
    ["check-attr", "-z", "--stdin", "filter"],
    paths.map((path) => `./${path}`).join("\0") + "\0",
    4 * fileLimit,
  );
  if (result.code !== 0) throw new Error("Could not read repository file attributes.");
  const fields = result.text.split("\0");
  const filtered = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3)
    if (filters.has(fields[index + 2])) filtered.add(fields[index].replace(/^\.\//, ""));
  return filtered;
}

async function hasRepository(root: string) {
  await checkedPath(root, "");
  const result = await git(root, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return false;
  const top = await realpath(result.text.replace(/\r?\n$/, ""));
  const delta = relative(top, await realpath(root));
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta))
    throw new Error("Git's working tree is outside the selected project.");
  return true;
}

export async function readRepositoryDirectory(
  root: string,
  path: string,
): Promise<RepositoryDirectory> {
  const checked = await openRepositoryPath(root, path, true);
  try {
    const directory = await opendir(checked.descriptor);
    const entries: RepositoryDirectory["entries"] = [];
    let limited = false;
    let payloadSize = 0;
    for await (const entry of directory) {
      const childPath = path ? `${path}/${entry.name}` : entry.name;
      if (!repositoryPathSchema.safeParse(childPath).success) continue;
      payloadSize += 3 * (childPath.length + entry.name.length) + 128;
      if (entries.length === 5000 || payloadSize > diffLimit) {
        limited = true;
        break;
      }
      entries.push({
        path: childPath,
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? "symlink"
          : entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : "unsupported",
      });
    }
    const ignored = entries.length
      ? await git(
          checked.root,
          ["check-ignore", "-z", "--stdin"],
          entries.map((entry) => `./${entry.path}`).join("\0") + "\0",
        )
      : { code: 0, text: "" };
    if (![0, 1, 128].includes(ignored.code))
      throw new Error("Could not read repository ignore rules.");
    if (
      ignored.code === 128 &&
      (await git(checked.root, ["rev-parse", "--is-inside-work-tree"])).code === 0
    )
      throw new Error("Could not read repository ignore rules.");
    const excluded = new Set(
      ignored.code === 0 ? ignored.text.split("\0").map((path) => path.replace(/^\.\//, "")) : [],
    );
    return {
      entries: entries
        .filter((entry) => !excluded.has(entry.path))
        .sort(
          (a, b) =>
            Number(b.kind === "directory") - Number(a.kind === "directory") ||
            a.name.localeCompare(b.name, "en"),
        ),
      limited,
    };
  } finally {
    await checked.file.close();
  }
}

export function parseRepositoryStatus(text: string): RepositoryChange[] {
  const fields = text.split("\0");
  const changes = new Map<string, RepositoryChange>();
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const code = field.slice(0, 2),
      path = field.slice(3);
    const previousPath = /[RC]/.test(code) ? (fields[++i] ?? null) : null;
    if (
      !repositoryPathSchema.safeParse(path).success ||
      (previousPath !== null && !repositoryPathSchema.safeParse(previousPath).success)
    )
      continue;
    const status =
      code.includes("U") || code === "AA" || code === "DD"
        ? "conflict"
        : code === "??"
          ? "untracked"
          : code.includes("R")
            ? "renamed"
            : code.includes("D")
              ? "deleted"
              : code.includes("A")
                ? "added"
                : code.includes("T")
                  ? "typechange"
                  : "modified";
    const previous = changes.get(path);
    changes.set(path, {
      path,
      previousPath,
      status: previous?.status === "deleted" && status === "untracked" ? "modified" : status,
    });
    if (changes.size > 20000)
      throw new Error("This repository has more than 20,000 changed files.");
  }
  return [...changes.values()];
}

export async function readRepositoryChanges(root: string): Promise<RepositoryChanges> {
  if (!(await hasRepository(root))) return { repository: false, head: null, changes: [] };
  const view = await createGitView(root);
  try {
    const overrides = await filterOverrides(root);
    const result = await git(
      root,
      [
        ...overrides.args,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=all",
        "--",
        ".",
      ],
      undefined,
      4 * fileLimit,
      view,
    );
    if (result.code !== 0) {
      const repository = await git(root, ["rev-parse", "--is-inside-work-tree"]);
      if (repository.code !== 0) return { repository: false, head: null, changes: [] };
      throw new Error("Could not read Git changes.");
    }
    const base = view.prefix;
    const changes = parseRepositoryStatus(result.text)
      .filter((change) => change.path.startsWith(base))
      .map((change) => ({
        ...change,
        path: change.path.slice(base.length),
        previousPath: change.previousPath?.startsWith(base)
          ? change.previousPath.slice(base.length)
          : null,
      }));
    let filterPaths = changes.map((change) => change.path);
    if (overrides.names.size) {
      const tracked = await git(
        root,
        [
          "ls-files",
          "--cached",
          "--deduplicate",
          "-z",
          "--",
          ".",
          ":(exclude,attr:!filter)**",
          ":(exclude,attr:-filter)**",
        ],
        undefined,
        4 * fileLimit,
        view,
        "attributes",
      );
      if (tracked.code !== 0) throw new Error("Could not read tracked file attributes.");
      filterPaths = [...new Set([...filterPaths, ...tracked.text.split("\0").filter(Boolean)])];
    }
    const entries = new Map<string, RepositoryChange>(
      changes.map((change) => [change.path, change]),
    );
    for (const path of await externalFilteredPaths(root, filterPaths, overrides.names)) {
      if (!repositoryPathSchema.safeParse(path).success) continue;
      entries.set(path, {
        ...(entries.get(path) ?? { path, previousPath: null, status: "modified" as const }),
        filtered: true,
      });
      if (entries.size > 20000)
        throw new Error("This repository has more than 20,000 changed or filtered files.");
    }
    return { repository: true, head: view.head, changes: [...entries.values()] };
  } finally {
    await closeGitView(view);
  }
}

export async function readRepositoryFile(
  root: string,
  path: string,
  previousPath?: string,
): Promise<RepositoryFile> {
  if (!path) throw new Error("Choose a file.");
  const unavailable = (
    reason: Extract<RepositoryFile, { kind: "unavailable" }>["reason"],
  ): RepositoryFile => ({ kind: "unavailable", reason });
  let checked: Awaited<ReturnType<typeof checkedPath>>;
  try {
    checked = await checkedPath(root, path, true);
  } catch (error) {
    if (error instanceof Error && error.message === "Symbolic links cannot be opened.")
      return unavailable("symlink");
    throw error;
  }
  if (previousPath !== undefined) {
    repositoryPathSchema.parse(previousPath);
    if (!previousPath) throw new Error("Choose a file.");
  }
  const info = await lstat(checked.target).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (info && !info.isFile()) return unavailable("unsupported");
  if (info && info.size > fileLimit) return unavailable("oversized");
  let content: Buffer | null = null;
  if (info) {
    const opened = await openRepositoryPath(checked.root, path);
    try {
      if (opened.info.size > fileLimit) return unavailable("oversized");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of opened.file.createReadStream({
        start: 0,
        end: fileLimit,
        autoClose: false,
      })) {
        size += chunk.length;
        if (size > fileLimit) return unavailable("oversized");
        chunks.push(chunk);
      }
      content = Buffer.concat(chunks, size);
    } finally {
      await opened.file.close();
    }
  }
  if (content && (content.includes(0) || !isUtf8(content))) return unavailable("binary");
  if (!(await hasRepository(checked.root)))
    return content
      ? { kind: "text", text: content.toString("utf8"), view: "file", comparison: "none" }
      : unavailable("missing");
  const view = await createGitView(checked.root);
  const readGit = (args: string[], input?: string, limit?: number) =>
    git(checked.root, args, input, limit, view);
  try {
    const head = { code: view.head ? 0 : 128 };
    const prefix = { code: 0, text: view.prefix };
    const index = await readGit(["ls-files", "--unmerged", "-z", "--", path]);
    if (index.code === 0 && index.text) return unavailable("conflict");
    const overrides = await filterOverrides(checked.root);
    if ((await externalFilteredPaths(checked.root, [path], overrides.names)).size)
      return unavailable("filtered");
    const prefixPath = prefix.text.replace(/\r?\n$/, "");
    const object = `HEAD:${prefixPath}${previousPath ?? path}`;
    const size = await readGit(["cat-file", "-s", object], undefined, 1024);
    if (size.code === 0 && Number(size.text) > fileLimit) return unavailable("oversized");
    let tracked: Awaited<ReturnType<typeof git>>;
    try {
      tracked =
        size.code !== 0
          ? size
          : await readGit(
              [...overrides.args, "cat-file", "--filters", `--path=${prefixPath}${path}`, object],
              undefined,
              fileLimit,
            );
    } catch (error) {
      if (error instanceof OutputLimitError) return unavailable("oversized");
      throw error;
    }
    if (head.code === 0 && tracked.code !== 0) {
      const entry = await readGit(["ls-tree", "-z", "HEAD", "--", previousPath ?? path]);
      if (entry.code !== 0 || entry.text)
        throw new Error(
          "The file's HEAD version is unavailable locally. Fetch it in your editor and retry.",
        );
    }
    if (head.code !== 0 || tracked.code !== 0) {
      if (!content) return unavailable("missing");
      return {
        kind: "text",
        text: content.toString("utf8"),
        view: "file",
        comparison: head.code !== 0 ? "unborn" : prefix.code === 0 ? "empty" : "none",
      };
    }
    try {
      const baseline = tracked;
      if (!baseline.utf8 || baseline.text.includes("\0")) return unavailable("binary");
      if (content && baseline.text === content.toString("utf8"))
        return { kind: "text", text: baseline.text, view: "file", comparison: "head" };
      const temporary = await mkdtemp(join(tmpdir(), "tidy-file-preview-"));
      try {
        const before = join(temporary, "before"),
          after = join(temporary, "after");
        await Promise.all([
          writeFile(before, baseline.text, { mode: 0o600 }),
          writeFile(after, content ?? Buffer.alloc(0), { mode: 0o600 }),
        ]);
        const diff = await git(checked.root, [
          "--git-dir=/dev/null",
          ...overrides.args,
          "-c",
          "core.autocrlf=false",
          "-c",
          "core.attributesFile=/dev/null",
          "-c",
          "diff.suppressBlankEmpty=false",
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--text",
          "--word-diff=none",
          "--line-prefix=",
          "--output-indicator-new=+",
          "--output-indicator-old=-",
          "--output-indicator-context= ",
          "--unified=3",
          "--",
          before,
          after,
        ]);
        if (![0, 1].includes(diff.code)) throw new Error("Could not read this diff.");
        const start = diff.text.indexOf("\n@@ ");
        if (start >= 0)
          return {
            kind: "text",
            text: diff.text.slice(start + 1),
            view: "diff",
            comparison: "head",
            ...(content === null ? { deleted: true as const } : {}),
          };
        return content
          ? { kind: "text", text: content.toString("utf8"), view: "file", comparison: "head" }
          : { kind: "text", text: "", view: "diff", comparison: "head", deleted: true };
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    } catch (error) {
      if (error instanceof OutputLimitError) return unavailable("oversized");
      throw error;
    }
  } finally {
    await closeGitView(view);
  }
}
