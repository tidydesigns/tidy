import { expect, test } from "bun:test";
import {
  VIDEO_CHUNK_BYTES,
  type VideoChunkRequest,
} from "../../../../../shared/contracts/video-preview";
import { loadVideoSource, VIDEO_TRANSFER_CONCURRENCY } from "./load-video-source";

const input = { projectId: crypto.randomUUID(), threadId: crypto.randomUUID(), href: "demo.mp4" };
const size = VIDEO_CHUNK_BYTES * 8 + 19;
function chunk(offset: number) {
  return {
    data: Buffer.alloc(
      Math.min(VIDEO_CHUNK_BYTES, size - offset),
      offset / VIDEO_CHUNK_BYTES,
    ).toString("base64"),
    size,
    mimeType: "video/mp4" as const,
    revision: "complete",
  };
}

test.each(["default", "fallback"])(
  "transfers overlap bounded requests and assemble out-of-order replies (%s decoder)",
  async (decoder) => {
    const descriptor = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
    try {
      if (decoder === "fallback")
        Object.defineProperty(Uint8Array, "fromBase64", { value: undefined, configurable: true });
      let active = 0;
      let peak = 0;
      const requests: VideoChunkRequest[] = [];
      const progress: number[] = [];
      const api = {
        readVideoChunk: async (request: VideoChunkRequest) => {
          requests.push(request);
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) =>
            setTimeout(resolve, 2 + (3 - ((request.offset / VIDEO_CHUNK_BYTES) % 4)) * 2),
          );
          active--;
          return chunk(request.offset);
        },
      };
      const result = await loadVideoSource({
        api,
        input,
        signal: new AbortController().signal,
        onProgress: (loaded) => progress.push(loaded),
      });
      expect(peak).toBe(VIDEO_TRANSFER_CONCURRENCY);
      expect(requests).toHaveLength(9);
      expect(requests[0].offset).toBe(0);
      expect(requests.slice(1).every((request) => request.revision === "complete")).toBe(true);
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      expect(bytes.length).toBe(size);
      for (let index = 0; index < 9; index++) expect(bytes[index * VIDEO_CHUNK_BYTES]).toBe(index);
      expect(progress.at(-1)).toBe(size);
      expect(progress.every((value, index) => index === 0 || value > progress[index - 1])).toBe(
        true,
      );
    } finally {
      if (descriptor) Object.defineProperty(Uint8Array, "fromBase64", descriptor);
      else Reflect.deleteProperty(Uint8Array, "fromBase64");
    }
  },
);

test("cancelling a transfer prevents more chunk requests and late progress", async () => {
  const controller = new AbortController();
  const progress: number[] = [];
  const requests: number[] = [];
  const pending = Promise.withResolvers<ReturnType<typeof chunk>>();
  const api = {
    readVideoChunk: async ({ offset }: VideoChunkRequest) => {
      requests.push(offset);
      if (offset === 0) return chunk(offset);
      return pending.promise;
    },
  };
  const transfer = loadVideoSource({
    api,
    input,
    signal: controller.signal,
    onProgress: (loaded) => progress.push(loaded),
  });
  while (requests.length < 5) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  pending.resolve(chunk(VIDEO_CHUNK_BYTES));
  await expect(transfer).rejects.toThrow();
  expect(requests).toHaveLength(5);
  expect(progress).toEqual([VIDEO_CHUNK_BYTES]);
});

test("revision changes and truncated chunks cannot produce a playable source", async () => {
  for (const change of ["revision", "truncated"]) {
    const api = {
      readVideoChunk: async ({ offset }: VideoChunkRequest) => {
        const value = chunk(offset);
        if (offset === VIDEO_CHUNK_BYTES) {
          if (change === "revision") value.revision = "replaced";
          else value.data = Buffer.from("partial").toString("base64");
        }
        return value;
      },
    };
    await expect(
      loadVideoSource({ api, input, signal: new AbortController().signal, onProgress() {} }),
    ).rejects.toThrow("changed");
  }
});
