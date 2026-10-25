import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseChatLink } from "../shared/chat-links";

export async function openChatLink({
  root,
  href,
  platform,
}: {
  root: string;
  href: string;
  platform: {
    openExternal(url: string): Promise<void>;
    showItemInFolder(path: string): void;
  };
}) {
  const link = parseChatLink(href);
  if (!link) throw new Error("This link is not supported.");
  if (link.kind === "external") return platform.openExternal(link.url);
  if (/^[a-z]:\//i.test(link.path) && process.platform !== "win32")
    throw new Error("This file belongs to a different operating system.");
  const projectRoot = await realpath(root);
  const path = await realpath(resolve(projectRoot, link.path));
  const within = relative(projectRoot, path);
  if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
    throw new Error("File links must stay inside this project.");
  if (!(await stat(path)).isFile()) throw new Error("This link does not point to a regular file.");
  platform.showItemInFolder(path);
}
