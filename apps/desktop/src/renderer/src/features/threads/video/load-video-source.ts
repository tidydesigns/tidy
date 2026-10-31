import { videoChunkTransfers } from "./video-task-queue";
import type { DesktopAPI } from "../../../../../shared/contracts/desktop";
import {
  MAX_VIDEO_BYTES,
  VIDEO_CHUNK_BYTES,
  type VideoChunkRequest,
  type VideoChunk,
} from "../../../../../shared/contracts/video-preview";

export type VideoInput = Pick<VideoChunkRequest, "projectId" | "threadId" | "href">;
export const VIDEO_TRANSFER_CONCURRENCY = 4;

const base64Bytes: typeof Uint8Array & {
  fromBase64?: (data: string) => Uint8Array<ArrayBuffer>;
} = Uint8Array;

export async function loadVideoSource({
  api,
  input,
  signal,
  onProgress,
}: {
  api: Pick<DesktopAPI, "readVideoChunk">;
  input: VideoInput;
  signal: AbortSignal;
  onProgress(loaded: number, total: number): void;
}) {
  signal.throwIfAborted();
  const read = (request: VideoChunkRequest) =>
    videoChunkTransfers.run({ signal, task: () => api.readVideoChunk(request) });
  const first = await read({ ...input, offset: 0 });
  signal.throwIfAborted();
  if (!Number.isSafeInteger(first.size) || first.size <= 0 || first.size > MAX_VIDEO_BYTES)
    throw new Error("Invalid recording size.");
  const parts: ArrayBuffer[] = new Array(Math.ceil(first.size / VIDEO_CHUNK_BYTES));
  let loaded = 0;
  let next = 1;
  let failed = false;
  async function accept(chunk: VideoChunk, index: number) {
    signal.throwIfAborted();
    if (
      chunk.size !== first.size ||
      chunk.revision !== first.revision ||
      chunk.mimeType !== first.mimeType
    )
      throw new Error("The recording changed while loading. Try again.");
    const bytes =
      typeof base64Bytes.fromBase64 === "function"
        ? base64Bytes.fromBase64(chunk.data).buffer
        : await (
            await fetch(`data:application/octet-stream;base64,${chunk.data}`, { signal })
          ).arrayBuffer();
    signal.throwIfAborted();
    if (failed) return;
    const expected = Math.min(VIDEO_CHUNK_BYTES, first.size - index * VIDEO_CHUNK_BYTES);
    if (bytes.byteLength !== expected)
      throw new Error("The recording changed while loading. Try again.");
    parts[index] = bytes;
    loaded += bytes.byteLength;
    onProgress(loaded, first.size);
  }
  const clear = () => {
    parts.length = 0;
  };
  signal.addEventListener("abort", clear, { once: true });
  try {
    await accept(first, 0);
    const workers = Array.from(
      { length: Math.min(VIDEO_TRANSFER_CONCURRENCY, parts.length - 1) },
      async () => {
        try {
          while (!failed && !signal.aborted) {
            const index = next++;
            if (index >= parts.length) return;
            const chunk = await read({
              ...input,
              offset: index * VIDEO_CHUNK_BYTES,
              revision: first.revision,
            });
            if (!failed) await accept(chunk, index);
          }
        } catch (error) {
          failed = true;
          throw error;
        }
      },
    );
    await Promise.all(workers);
    signal.throwIfAborted();
    return { blob: new Blob(parts, { type: first.mimeType }), size: first.size };
  } finally {
    signal.removeEventListener("abort", clear);
    clear();
  }
}
