import { createHash } from "node:crypto";
import { CHAT_IMAGE_CHUNK_BYTES, MAX_CHAT_IMAGE_BYTES } from "../../shared/contracts/chat-images";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Root, RootContent } from "mdast";
import { resolveChatFilePath } from "./chat-file-path";
import { openProjectVideo as openImageFile } from "../platform/project-video-file";
import { parseChatLink } from "../../shared/models/chat-links";
import type { Thread } from "../../shared/contracts/desktop";

const referenceCache = new Map<string, { paths: Set<string>; cost: number }>();
let referenceCacheBytes = 0;
const referenceCacheLimit = 4 * 1024 * 1024;

function imagePaths(text: string) {
  const cached = referenceCache.get(text);
  if (cached) {
    referenceCache.delete(text);
    referenceCache.set(text, cached);
    return cached.paths;
  }
  const tree = fromMarkdown(text);
  const definitions = new Map<string, string>();
  const pending: (Root | RootContent)[] = [tree];
  const destinations: string[] = [];
  const references: string[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url);
    if (node.type === "image" || node.type === "link") destinations.push(node.url);
    if (node.type === "imageReference" || node.type === "linkReference")
      references.push(node.identifier);
    if ("children" in node)
      for (let index = node.children.length - 1; index >= 0; index--)
        pending.push(node.children[index]);
  }
  for (const id of references) {
    const url = definitions.get(id);
    if (url) destinations.push(url);
  }
  const paths = new Set<string>();
  for (const url of destinations) {
    const link = parseChatLink(url);
    if (link?.kind === "file") paths.add(link.path);
  }
  const cost = 2 * (text.length + [...paths].reduce((sum, path) => sum + path.length, 0));
  if (cost <= referenceCacheLimit) {
    while (referenceCache.size >= 128 || referenceCacheBytes + cost > referenceCacheLimit) {
      const oldest = referenceCache.entries().next().value;
      if (!oldest) break;
      referenceCache.delete(oldest[0]);
      referenceCacheBytes -= oldest[1].cost;
    }
    referenceCache.set(text, { paths, cost });
    referenceCacheBytes += cost;
  }
  return paths;
}

export async function readChatImage({
  root,
  thread,
  href,
  offset = 0,
  revision,
}: {
  root: string;
  thread: Thread;
  href: string;
  offset?: number;
  revision?: string;
}) {
  const link = parseChatLink(href);
  if (!link || link.kind !== "file" || !/\.(?:png|jpe?g|gif|webp)$/i.test(link.name))
    throw new Error("This image format is not supported.");
  if (!thread.messages.some((message) => imagePaths(message.text).has(link.path)))
    throw new Error("This image is not referenced in the thread.");
  const path = await resolveChatFilePath({ root, path: link.path });
  const file = await openImageFile(path);
  let bytes: Buffer;
  let signature: Buffer;
  let size: number;
  let currentRevision: string;
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_CHAT_IMAGE_BYTES))
      throw new Error("Image previews require a regular file up to 16 MiB.");
    size = Number(before.size);
    currentRevision = createHash("sha256")
      .update(`${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`)
      .digest("hex");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size)
      throw new Error("Invalid image offset.");
    if ((offset > 0 && !revision) || (revision && revision !== currentRevision))
      throw new Error("The image changed while loading. Try again.");
    signature = Buffer.alloc(Math.min(12, size));
    await file.read(signature, 0, signature.length, 0);
    bytes = Buffer.alloc(Math.min(CHAT_IMAGE_CHUNK_BYTES, size - offset));
    let loaded = 0;
    while (loaded < bytes.length) {
      const result = await file.read(bytes, loaded, bytes.length - loaded, offset + loaded);
      if (!result.bytesRead) throw new Error("The image changed while loading. Try again.");
      loaded += result.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error("The image changed while loading. Try again.");
  } finally {
    await file.close();
  }
  const mime = signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : signature[0] === 255 && signature[1] === 216 && signature[2] === 255
      ? "image/jpeg"
      : ["GIF87a", "GIF89a"].includes(signature.subarray(0, 6).toString("ascii"))
        ? "image/gif"
        : signature.subarray(0, 4).toString("ascii") === "RIFF" &&
            signature.subarray(8, 12).toString("ascii") === "WEBP"
          ? "image/webp"
          : null;
  if (!mime) throw new Error("This file is not a supported image.");
  return {
    name: link.name,
    dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
    offset,
    size,
    revision: currentRevision,
  };
}
