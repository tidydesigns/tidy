import { expect, mock, test } from "bun:test";
import { createEmbeddedFontCache } from "./embedded-font-cache";

test("simultaneous and repeated exports share the same embedded font bytes", async () => {
  let complete!: (data: string) => void;
  const read = mock(() => new Promise<string>((resolve) => (complete = resolve)));
  const load = createEmbeddedFontCache(read);
  const first = load("font");
  const second = load("font");
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(1);
  complete("data:font/woff2;base64,AQID");
  expect(await first).toBe(await second);
  expect(await load("font")).toBe("data:font/woff2;base64,AQID");
  expect(read).toHaveBeenCalledTimes(1);
});

test("failed font reads are retryable", async () => {
  const read = mock(async () => "font");
  read.mockRejectedValueOnce(new Error("unavailable"));
  const load = createEmbeddedFontCache(read);
  await expect(load("font")).rejects.toThrow("unavailable");
  expect(await load("font")).toBe("font");
  expect(read).toHaveBeenCalledTimes(2);
});

test("font reuse stays bounded and retains recently used faces", async () => {
  const read = mock(async (url: string) => url);
  const load = createEmbeddedFontCache(read, { maxEntries: 2, maxBytes: 16 });
  await load("a");
  await load("b");
  await load("a");
  await load("c");
  await load("a");
  expect(read.mock.calls.map(([url]) => url)).toEqual(["a", "b", "c"]);
  await load("b");
  expect(read.mock.calls.map(([url]) => url)).toEqual(["a", "b", "c", "b"]);

  // Oversized faces still export, but cannot displace the memory ceiling.
  expect(await load("oversized")).toBe("oversized");
  await load("oversized");
  expect(read.mock.calls.filter(([url]) => url === "oversized")).toHaveLength(2);
});

test("an evicted in-flight read cannot replace a newer cache entry", async () => {
  let complete!: (data: string) => void;
  const read = mock(async (url: string) => url);
  read.mockImplementationOnce(() => new Promise<string>((resolve) => (complete = resolve)));
  const load = createEmbeddedFontCache(read, { maxEntries: 1 });
  const older = load("a");
  await Promise.resolve();
  await load("b");
  expect(await load("a")).toBe("a");
  complete("older");
  expect(await older).toBe("older");
  expect(await load("a")).toBe("a");
  expect(read).toHaveBeenCalledTimes(3);
});
