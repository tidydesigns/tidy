import { afterEach, expect, test } from "bun:test";
import { rasterizeExport } from "./export-selection";

const originalDocument = globalThis.document;
const originalImage = globalThis.Image;
afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.Image = originalImage;
});

function browser(failEncoding = false) {
  const surfaces: { width: number; height: number; getContext: () => unknown }[] = [];
  const allocated: number[] = [];
  const draws: unknown[][] = [];
  const images: { src: string; onload: (() => void) | null; onerror: unknown }[] = [];
  globalThis.Image = class {
    onload: (() => void) | null = null;
    onerror = null;
    current = "";
    constructor() {
      images.push(this);
    }
    get src() {
      return this.current;
    }
    set src(value: string) {
      this.current = value;
      if (value) queueMicrotask(() => this.onload?.());
    }
    async decode() {}
  } as unknown as typeof Image;
  globalThis.document = {
    createElement() {
      const context = {
        drawImage: (...args: unknown[]) => draws.push(args),
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
      };
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => context,
        toBlob(callback: (blob: Blob | null) => void, mime: string) {
          allocated.push(...surfaces.map((s) => s.width * s.height));
          callback(failEncoding ? null : new Blob(["encoded"], { type: mime }));
        },
      };
      surfaces.push(canvas);
      return canvas;
    },
  } as unknown as Document;
  return { surfaces, draws, allocated, image: () => images[0] };
}

test("PNG keeps requested dimensions, samples fine edges, and releases its temporary surface before encoding", async () => {
  const state = browser();
  const blob = await rasterizeExport('<svg xmlns="http://www.w3.org/2000/svg"/>', 1920, 1080);
  expect(blob.type).toBe("image/png");
  expect(state.draws[0].slice(1)).toEqual([0, 0, 3840, 2160]);
  expect(state.draws[1].slice(1)).toEqual([0, 0, 1920, 1080]);
  expect(state.allocated).toEqual([1920 * 1080, 0]);
  expect(state.surfaces.every((s) => s.width === 0 && s.height === 0)).toBe(true);
  expect(state.image().src).toBe("");
});

test("large exports avoid allocating an oversized supersampling surface", async () => {
  const state = browser();
  await rasterizeExport("<svg/>", 16000, 2000);
  expect(state.surfaces).toHaveLength(1);
  expect(state.draws[0].slice(1)).toEqual([0, 0, 16000, 2000]);
});

test("failed PNG encoding releases both surfaces and the decoded image", async () => {
  const state = browser(true);
  await expect(rasterizeExport("<svg/>", 1920, 1080)).rejects.toThrow("could not create");
  expect(state.surfaces.every((s) => s.width === 0 && s.height === 0)).toBe(true);
  expect(state.image().src).toBe("");
  expect(state.image().onload).toBeNull();
});
