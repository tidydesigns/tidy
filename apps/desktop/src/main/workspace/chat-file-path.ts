import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export async function resolveChatFilePath({ root, path }: { root: string; path: string }) {
  if (/^[a-z]:\//i.test(path) && process.platform !== "win32")
    throw new Error("This file belongs to a different operating system.");
  const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  return realpath(resolve(root, expanded)).catch(rethrowChatFileError);
}

export function rethrowChatFileError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR")
      throw new Error(
        "This file is no longer available on the machine running this thread. It may have been moved or deleted.",
      );
    if (error.code === "EACCES" || error.code === "EPERM")
      throw new Error("This file cannot be accessed on the machine running this thread.");
  }
  throw error;
}
