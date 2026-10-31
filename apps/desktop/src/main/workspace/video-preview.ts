import { openProjectVideo } from "../platform/project-video-file";
import { realpath } from "node:fs/promises";
import { resolveChatFilePath } from "./chat-file-path";
import { parseChatLink } from "../../shared/models/chat-links";
import {
  MAX_VIDEO_BYTES,
  VIDEO_CHUNK_BYTES,
  videoMimeType,
  type VideoChunk,
  type VideoChunkRequest,
} from "../../shared/contracts/video-preview";

export async function readVideoChunk({
  root,
  href,
  offset,
  revision,
}: Pick<VideoChunkRequest, "href" | "offset" | "revision"> & {
  root: string;
}): Promise<VideoChunk> {
  const link = parseChatLink(href);
  const mimeType = link?.kind === "file" ? videoMimeType(link.path) : null;
  if (!link || link.kind !== "file" || !mimeType) throw new Error("Choose a supported video file.");
  const path = await resolveChatFilePath({ root, path: link.path });
  const file = await openProjectVideo(path);
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile()) throw new Error("This video is not a regular file.");
    if (!info.size)
      throw new Error("This recording is empty. Try again when recording has finished.");
    if (info.size > BigInt(MAX_VIDEO_BYTES))
      throw new Error(
        "Video previews support recordings up to 128 MiB. Export a shorter recording and try again.",
      );
    if ((await realpath(path)) !== path) throw new Error("The video path changed. Open it again.");
    const currentRevision = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    if ((offset > 0 && !revision) || (revision && revision !== currentRevision))
      throw new Error(
        "The recording changed while loading. Try again when recording has finished.",
      );
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= info.size)
      throw new Error("Invalid video position.");
    const size = Number(info.size);
    const bytes = Buffer.alloc(Math.min(VIDEO_CHUNK_BYTES, size - offset));
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, offset + length);
      if (!result.bytesRead) throw new Error("The recording changed while loading. Try again.");
      length += result.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      after.size !== info.size ||
      after.mtimeNs !== info.mtimeNs ||
      after.ctimeNs !== info.ctimeNs
    )
      throw new Error("The recording changed while loading. Try again.");
    return { data: bytes.toString("base64"), size, mimeType, revision: currentRevision };
  } finally {
    await file.close();
  }
}
