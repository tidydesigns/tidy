import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { repositoryPathSchema } from "../../shared/contracts/repository-files";

export async function checkedRepositoryPath(root: string, value: string, missing = false) {
  if (process.platform === "win32")
    throw new Error("Repository file browsing is not supported on Windows yet.");
  const path = repositoryPathSchema.parse(value);
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) throw new Error("The project directory moved. Open it again.");
  const parts = path ? path.split("/") : [];
  let target = canonicalRoot;
  for (let index = 0; index < parts.length; index++) {
    target = join(target, parts[index]);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (missing && error instanceof Error && "code" in error && error.code === "ENOENT") {
        target = join(target, ...parts.slice(index + 1));
        break;
      }
      throw error;
    }
    try {
      target = await realpath(target);
      const delta = relative(canonicalRoot, target);
      if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta))
        throw new Error("Choose a path inside this repository.");
      repositoryPathSchema.parse(delta.split(sep).join("/"));
    } catch (error) {
      if (info.isSymbolicLink()) throw new Error("Symbolic link target cannot be opened.");
      throw error;
    }
    if (index < parts.length - 1 && !(await lstat(target)).isDirectory())
      throw new Error("Not a repository folder.");
  }
  return { root: canonicalRoot, target, path };
}

export async function openRepositoryPath(root: string, path: string, directory = false) {
  const checked = await checkedRepositoryPath(root, path);
  // Darwin's O_NOFOLLOW_ANY rejects symlinks in every path component (bsd/sys/fcntl.h).
  const noFollow = process.platform === "darwin" ? 0x20000000 : (constants.O_NOFOLLOW ?? 0);
  const file = await open(
    checked.target,
    constants.O_RDONLY |
      noFollow |
      (constants.O_NONBLOCK ?? 0) |
      (directory ? (constants.O_DIRECTORY ?? 0) : 0),
  );
  try {
    const descriptor = process.platform === "linux" ? `/proc/self/fd/${file.fd}` : checked.target;
    const actual = await realpath(process.platform === "linux" ? descriptor : checked.target);
    const delta = relative(checked.root, actual);
    if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta))
      throw new Error("Choose a path inside this repository.");
    repositoryPathSchema.parse(delta.split(sep).join("/"));
    const info = await file.stat();
    if (directory ? !info.isDirectory() : !info.isFile())
      throw new Error("Choose a regular repository file or folder.");
    if (process.platform !== "linux") {
      // Path-based directory APIs must still refer to the object we opened.
      // This detects persistent replacements; it cannot make a later pathname lookup atomic.
      const current = await lstat(checked.target);
      if (current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino)
        throw new Error("The project directory moved. Open it again.");
    }
    return { ...checked, file, info, descriptor };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function assertRepositoryPathStable(
  opened: Awaited<ReturnType<typeof openRepositoryPath>>,
) {
  const current = await openRepositoryPath(opened.root, opened.path, opened.info.isDirectory());
  try {
    if (
      current.target !== opened.target ||
      current.info.dev !== opened.info.dev ||
      current.info.ino !== opened.info.ino
    )
      throw new Error("The project directory moved. Open it again.");
  } finally {
    await current.file.close();
  }
}
