import { resolveChatFilePath } from "./chat-file-path";
import { openProjectVideo as openImageFile } from "../platform/project-video-file";
import { parseChatLink } from "../../shared/models/chat-links";
import type { Thread } from "../../shared/contracts/desktop";

export async function readChatImage({
  root,
  thread,
  href,
}: {
  root: string;
  thread: Thread;
  href: string;
}) {
  const link = parseChatLink(href);
  if (!link || link.kind !== "file" || !/\.(?:png|jpe?g|gif|webp)$/i.test(link.name))
    throw new Error("This image format is not supported.");
  if (!thread.messages.some((message) => message.text.includes(href)))
    throw new Error("This image is not referenced in the thread.");
  if (/^[a-z]:\//i.test(link.path) && process.platform !== "win32")
    throw new Error("This image belongs to a different operating system.");
  const path = await resolveChatFilePath({ root, path: link.path });
  const file = await openImageFile(path);
  let bytes: Buffer;
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > 16n * 1024n * 1024n)
      throw new Error("Image previews require a regular file up to 16 MiB.");
    bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("The image changed while loading. Try again.");
      offset += result.bytesRead;
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
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "image/jpeg"
      : ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
        ? "image/gif"
        : bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
            bytes.subarray(8, 12).toString("ascii") === "WEBP"
          ? "image/webp"
          : null;
  if (!mime) throw new Error("This file is not a supported image.");
  return { name: link.name, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` };
}
