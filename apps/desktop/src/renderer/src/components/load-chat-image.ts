import {
  CHAT_IMAGE_CHUNK_BYTES,
  chatImageSchema,
  type ChatImageRequest,
} from "../../../shared/contracts/chat-images";
import type { DesktopAPI } from "../../../shared/contracts/desktop";
import {
  videoFileTransfers,
  videoChunkTransfers,
} from "../features/threads/video/video-task-queue";

type ImageAPI = Pick<DesktopAPI, "readChatImage">;
type Input = Pick<ChatImageRequest, "projectId" | "threadId" | "href">;
type Load = { promise: Promise<string>; controller: AbortController; users: number };
const pendingImages = new WeakMap<ImageAPI, Map<string, Load>>();

export async function readChatImageSource({
  api,
  input,
  signal,
}: {
  api: ImageAPI;
  input: Input;
  signal: AbortSignal;
}) {
  return videoFileTransfers.run({
    signal,
    task: async () => {
      const read = async (offset: number, revision?: string) => {
        signal.throwIfAborted();
        const result = await videoChunkTransfers.run({
          signal,
          task: () =>
            api.readChatImage(input.projectId, input.threadId, input.href, { offset, revision }),
        });
        signal.throwIfAborted();
        return chatImageSchema.parse(result);
      };
      const first = await read(0);
      const prefix = first.dataUrl.slice(0, first.dataUrl.indexOf(",") + 1);
      const parts: string[] = [];
      let offset = 0;
      let chunk = first;
      while (true) {
        const data = chunk.dataUrl.slice(chunk.dataUrl.indexOf(",") + 1);
        const bytes =
          (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
        if (
          chunk.offset !== offset ||
          chunk.revision !== first.revision ||
          chunk.size !== first.size ||
          !chunk.dataUrl.startsWith(prefix) ||
          bytes !== Math.min(CHAT_IMAGE_CHUNK_BYTES, first.size - offset)
        )
          throw new Error("The image changed while loading. Try again.");
        parts.push(data);
        offset += bytes;
        if (offset === first.size) return prefix + parts.join("");
        chunk = await read(offset, first.revision);
      }
    },
  });
}

export function loadChatImage(api: ImageAPI, input: Input) {
  let cache = pendingImages.get(api);
  if (!cache) {
    cache = new Map();
    pendingImages.set(api, cache);
  }
  const key = JSON.stringify([input.projectId, input.threadId, input.href]);
  let load = cache.get(key);
  if (!load || load.controller.signal.aborted) {
    if (cache.size >= 64)
      return {
        promise: Promise.reject(new Error("Image loading is busy. Retry shortly.")),
        release() {},
      };
    const controller = new AbortController();
    const promise = readChatImageSource({ api, input, signal: controller.signal });
    load = { promise, controller, users: 0 };
    cache.set(key, load);
    const current = cache;
    const clear = () => {
      if (current.get(key) === load) current.delete(key);
    };
    void promise.then(clear, clear);
  }
  load.users++;
  let released = false;
  return {
    promise: load.promise,
    release() {
      if (released) return;
      released = true;
      load.users--;
      if (load.users === 0) load.controller.abort();
    },
  };
}
