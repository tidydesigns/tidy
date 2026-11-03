import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseChatLink } from "../../shared/models/chat-links";
import { repositoryPathSchema } from "../../shared/contracts/repository-files";

export function resolveRepositoryLink(root: string, href: string) {
  const link = parseChatLink(href);
  if (!link || link.kind !== "file") throw new Error("Choose a file reference.");
  if (/^[a-z]:\//i.test(link.path) && process.platform !== "win32")
    throw new Error("This file belongs to a different operating system.");
  const expanded = link.path.startsWith("~/") ? resolve(homedir(), link.path.slice(2)) : link.path;
  const path = relative(root, resolve(root, expanded));
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new Error("This file is outside this thread's project. Open its project to preview it.");
  const parsed = repositoryPathSchema.safeParse(path.split(sep).join("/"));
  if (!parsed.success) throw new Error("This file cannot be previewed inside this project.");
  return parsed.data;
}

export async function resolveRepositoryReference(root: string, href: string) {
  try {
    return resolveRepositoryLink(root, href);
  } catch (error) {
    const link = parseChatLink(href);
    if (link?.kind !== "file") throw error;
    const expanded = link.path.startsWith("~/")
      ? resolve(homedir(), link.path.slice(2))
      : link.path;
    if (
      !isAbsolute(expanded) ||
      !(error instanceof Error) ||
      !error.message.includes("outside this thread's project")
    )
      throw error;
    const actual = await realpath(expanded).catch(() => {
      throw error;
    });
    return resolveRepositoryLink(root, pathToFileURL(actual).href);
  }
}
