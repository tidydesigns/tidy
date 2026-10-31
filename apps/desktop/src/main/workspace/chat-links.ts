import { z } from "zod";
import { stat } from "node:fs/promises";
import { resolveChatFilePath, rethrowChatFileError } from "./chat-file-path";
import { parseChatLink } from "../../shared/models/chat-links";

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
  const path = await resolveChatFilePath({ root, path: link.path });
  if (!(await stat(path).catch(rethrowChatFileError)).isFile())
    throw new Error("This link does not point to a regular file.");
  platform.showItemInFolder(path);
}

export const chatLinkRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    href: z.string().min(1).max(4096),
  })
  .strict();

export async function openConnectedChatLink({
  input,
  platform,
  getLocalProjectRoot,
}: {
  input: unknown;
  platform: { openExternal(url: string): Promise<void>; showItemInFolder(path: string): void };
  getLocalProjectRoot?: (projectId: string) => Promise<string>;
}) {
  const { projectId, href } = chatLinkRequestSchema.parse(input);
  const link = parseChatLink(href);
  if (!link) throw new Error("This link is not supported.");
  if (link.kind === "external") return platform.openExternal(link.url);
  if (!getLocalProjectRoot)
    throw new Error(
      "This file is on the remote machine. Open it there; local file browsing is unavailable for remote projects.",
    );
  await openChatLink({ root: await getLocalProjectRoot(projectId), href, platform });
}
