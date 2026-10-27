import { expect, test } from "bun:test";
import { CloudAssetDownloads } from "./cloud-asset-downloads";

test("background work leaves capacity for requested images and promotes shared queued downloads", async () => {
  const downloads = new CloudAssetDownloads();
  const gate = Promise.withResolvers<string>();
  const started: string[] = [];
  const load = (id: string) => () => {
    started.push(id);
    return gate.promise;
  };
  const pending = ["a", "b", "c", "d", "e"].map((id) => downloads.run("file", id, false, load(id)));
  try {
    await Bun.sleep(0);
    expect(started).toEqual(["a", "b", "c"]);
    const requested = downloads.run("file", "e", true, load("duplicate"));
    expect(requested).toBe(pending[4]);
    await Bun.sleep(0);
    expect(started).toEqual(["a", "b", "c", "e"]);
    gate.resolve("image bytes");
    expect(await requested).toBe("image bytes");
  } finally {
    gate.resolve("image bytes");
    await Promise.all(pending);
    await downloads.stop();
  }
  expect(started).toEqual(["a", "b", "c", "e", "d"]);
});

test("cancellation drains started work and rejects queued images without launching them", async () => {
  const downloads = new CloudAssetDownloads();
  const gate = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const pending = Array.from({ length: 6 }, (_, id) =>
    downloads.run("file", String(id), false, async (signal) => {
      signals.push(signal);
      await gate.promise;
      signal.throwIfAborted();
      return "image bytes";
    }),
  );
  const results = Promise.allSettled(pending);
  await Bun.sleep(0);
  let stopped = false;
  const stop = downloads.stop().then(() => {
    stopped = true;
  });
  try {
    await Bun.sleep(0);
    expect(stopped).toBe(false);
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  } finally {
    gate.resolve();
    await stop;
  }
  expect((await results).every((result) => result.status === "rejected")).toBe(true);
  expect(signals).toHaveLength(3);
});
