import { opendir } from "node:fs/promises";
import { basename } from "node:path";
import { git } from "./repository-git";
import { assertRepositoryPathStable, openRepositoryPath } from "./repository-path";
import { repositoryPathSchema } from "../../shared/contracts/repository-files";
import {
  repositorySearchQuerySchema,
  type RepositorySearch,
} from "../../shared/contracts/repository-search";

const excludedDirectories = new Set([".git", "node_modules", ".next", ".turbo", "dist", "build"]);
type Inventory = { paths: string[]; limited: boolean };
const inventories = new Map<string, Promise<Inventory>>();

async function readInventory(root: string): Promise<Inventory> {
  const result = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (result.code === 0) {
    const files = await git(
      root,
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--deduplicate",
        "-z",
        ...[...excludedDirectories].flatMap((name) => [
          `--exclude=${name}/**`,
          `--exclude=**/${name}/**`,
        ]),
        "--",
        ".",
      ],
      undefined,
      8 * 1024 * 1024,
    );
    if (files.code !== 0) throw new Error("Could not search repository files.");
    const paths = files.text.split("\0", 30001).filter(Boolean);
    return { paths: paths.slice(0, 30000), limited: paths.length > 30000 };
  }
  if (!/^fatal: not a git repository \(/.test(result.stderr))
    throw new Error("Could not search this repository. Check its configuration and retry.");
  const directories = [""];
  const paths: string[] = [];
  const deadline = Date.now() + 2000;
  let inspected = 0,
    bytes = 0;
  for (let index = 0; index < directories.length; index++) {
    const path = directories[index];
    const opened = await openRepositoryPath(root, path, true);
    try {
      const directory = await opendir(opened.descriptor);
      for await (const entry of directory) {
        if (++inspected > 30000 || Date.now() > deadline || bytes > 8 * 1024 * 1024) {
          await assertRepositoryPathStable(opened);
          return { paths, limited: true };
        }
        const child = path ? `${path}/${entry.name}` : entry.name;
        if (!repositoryPathSchema.safeParse(child).success) continue;
        bytes += Buffer.byteLength(child);
        if (entry.isDirectory() && !excludedDirectories.has(entry.name)) directories.push(child);
        else if (entry.isFile() || entry.isSymbolicLink()) paths.push(child);
      }
      await assertRepositoryPathStable(opened);
    } finally {
      await opened.file.close();
    }
  }
  return { paths, limited: false };
}

function inventory(root: string): Promise<Inventory> {
  const existing = inventories.get(root);
  if (existing) return existing;
  if (inventories.size >= 4)
    return Promise.reject(new Error("File search is busy. Try again shortly."));
  const value = readInventory(root);
  const remove = () => {
    if (inventories.get(root) === value) inventories.delete(root);
  };
  inventories.set(root, value);
  void value.then(remove, remove);
  return value;
}

export async function searchRepositoryFiles(
  root: string,
  query: string,
): Promise<RepositorySearch> {
  const needle = repositorySearchQuerySchema.parse(query).toLowerCase();
  const { paths, limited } = await inventory(root);
  const entries: RepositorySearch["entries"] = [];
  const deadline = Date.now() + 2000;
  let inspected = 0;
  for (const path of paths) {
    if (!repositoryPathSchema.safeParse(path).success || !path.toLowerCase().includes(needle))
      continue;
    if (entries.length === 500 || ++inspected > 2000 || Date.now() >= deadline)
      return { entries, limited: true };
    try {
      const file = await openRepositoryPath(root, path);
      await file.file.close();
      entries.push({ path, name: basename(path), kind: "file" });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "EACCES", "EPERM", "ELOOP", "ENOTDIR"].includes(String(error.code))
      )
        continue;
      if (
        error instanceof Error &&
        /Symbolic link|Choose a (path|regular)|Not a repository folder|project directory moved/.test(
          error.message,
        )
      )
        continue;
      throw error;
    }
  }
  return { entries, limited };
}
