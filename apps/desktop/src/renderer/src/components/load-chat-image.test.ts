import { expect, test } from "bun:test";
import { CHAT_IMAGE_CHUNK_BYTES, type ChatImage } from "../../../shared/contracts/chat-images";
import type { DesktopAPI } from "../../../shared/contracts/desktop";
import { loadChatImage, readChatImageSource } from "./load-chat-image";

const input = { projectId: crypto.randomUUID(), threadId: crypto.randomUUID(), href: "screen.png" };
const chunk = (offset: number, size: number): ChatImage => ({
  name: "screen.png",
  dataUrl: `data:image/png;base64,${Buffer.alloc(Math.min(CHAT_IMAGE_CHUNK_BYTES, size - offset), 17).toString("base64")}`,
  offset,
  size,
  revision: "first-version",
});

test("chunks reconstruct an exact image including its padded final chunk", async () => {
  const size = CHAT_IMAGE_CHUNK_BYTES * 2 + 7;
  const offsets: number[] = [];
  const api: Pick<DesktopAPI, "readChatImage"> = {
    async readChatImage(_project, _thread, _href, request) {
      const offset = request?.offset ?? 0;
      offsets.push(offset);
      expect(request?.revision).toBe(offset === 0 ? undefined : "first-version");
      return chunk(offset, size);
    },
  };
  const source = await readChatImageSource({ api, input, signal: new AbortController().signal });
  expect(Buffer.from(source.split(",")[1], "base64")).toEqual(Buffer.alloc(size, 17));
  expect(offsets).toEqual([0, CHAT_IMAGE_CHUNK_BYTES, CHAT_IMAGE_CHUNK_BYTES * 2]);
});

test("changed revisions and malformed chunk sizes fail instead of assembling mixed images", async () => {
  for (const changed of ["revision", "size", "offset", "dataUrl"] as const) {
    const api: Pick<DesktopAPI, "readChatImage"> = {
      async readChatImage(_project, _thread, _href, request) {
        const result = chunk(request?.offset ?? 0, CHAT_IMAGE_CHUNK_BYTES + 7);
        if (request?.offset) {
          if (changed === "revision") result.revision = "changed";
          if (changed === "size") result.size++;
          if (changed === "offset") result.offset++;
          if (changed === "dataUrl") result.dataUrl = "data:image/png;base64,AA==";
        }
        return result;
      },
    };
    await expect(
      readChatImageSource({ api, input, signal: new AbortController().signal }),
    ).rejects.toThrow("changed");
  }
});

test("distinct images share bounded transfers and duplicate consumers release independently", async () => {
  let active = 0;
  let peak = 0;
  let reads = 0;
  const gate = Promise.withResolvers<void>();
  const api: Pick<DesktopAPI, "readChatImage"> = {
    async readChatImage() {
      reads++;
      peak = Math.max(peak, ++active);
      await gate.promise;
      active--;
      return chunk(0, 7);
    },
  };
  const first = loadChatImage(api, input);
  const duplicate = loadChatImage(api, input);
  expect(first.promise).toBe(duplicate.promise);
  first.release();
  const others = Array.from({ length: 6 }, (_, index) =>
    loadChatImage(api, { ...input, href: `${index}.png` }),
  );
  await Bun.sleep(5);
  expect(reads).toBe(2);
  gate.resolve();
  await Promise.all([duplicate.promise, ...others.map((load) => load.promise)]);
  expect(peak).toBe(2);
  expect(reads).toBe(7);
  duplicate.release();
  others.forEach((load) => load.release());
});

test("releasing the last consumer stops continuation reads and allows retry", async () => {
  let reads = 0;
  const gate = Promise.withResolvers<ChatImage>();
  const api: Pick<DesktopAPI, "readChatImage"> = {
    async readChatImage() {
      reads++;
      return reads === 1 ? gate.promise : chunk(0, 7);
    },
  };
  const load = loadChatImage(api, input);
  const cancelled = load.promise.catch((error: unknown) => error);
  await Bun.sleep(5);
  load.release();
  expect(await cancelled).toBeInstanceOf(DOMException);
  gate.resolve(chunk(0, CHAT_IMAGE_CHUNK_BYTES + 7));
  const retry = loadChatImage(api, input);
  await retry.promise;
  retry.release();
  expect(reads).toBe(2);
});
