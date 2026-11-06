import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoArtifacts, readVideoArtifact, videoLinks } from "./video-artifacts";
import type { VideoArtifact } from "../../shared/contracts/video-artifacts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(prepare?: ConstructorParameters<typeof VideoArtifacts>[0]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tidy-video-artifact-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, "storage");
  await mkdir(storage);
  const pipeline = new VideoArtifacts(prepare);
  cleanups.push(() => pipeline.close());
  return { root, storage, pipeline };
}
const prepared: NonNullable<ConstructorParameters<typeof VideoArtifacts>[0]> = async ({
  sourcePath,
}) => ({
  width: 320,
  height: 180,
  duration: 1,
  codec: "h264",
  originalMimeType: "video/mp4",
  playbackFile: sourcePath,
  playbackMimeType: "video/mp4",
  posterFile: undefined,
  transcoded: false,
});
function enqueue(f: Awaited<ReturnType<typeof fixture>>, href: string) {
  const artifact: VideoArtifact = {
    id: randomUUID(),
    name: "clip.mp4",
    sourceHref: href,
    status: "queued",
  };
  const done = Promise.withResolvers<void>();
  f.pipeline.enqueue({
    artifact,
    root: f.root,
    storage: async () => f.storage,
    update: async (patch) => {
      Object.assign(artifact, patch);
      if (["ready", "failed", "cancelled"].includes(artifact.status)) done.resolve();
    },
  });
  return { artifact, done: done.promise };
}
test("only explicit local links become bounded deduplicated video artifacts", () => {
  const result = videoLinks(
    "[Video](./clip.mp4) [Again](./clip.mp4) [Online](https://example.com/a.mp4) ` [Code](./code.mp4) ` ![Image](./image.mp4) [Spaces](<./my clip.mov>)",
  );
  expect(result.map((item) => item.sourceHref)).toEqual(["./clip.mp4", "./my clip.mov"]);
  expect(
    videoLinks(Array.from({ length: 20 }, (_, i) => `[Video](./${i}.mp4)`).join(" ")),
  ).toHaveLength(4);
});
test("original bytes survive edits to source and playback reads remain bounded", async () => {
  const f = await fixture(prepared);
  await writeFile(join(f.root, "clip.mp4"), "original-video");
  const job = enqueue(f, "./clip.mp4");
  await job.done;
  expect(job.artifact.status).toBe("ready");
  expect(job.artifact.playbackUsesOriginal).toBe(true);
  await writeFile(join(f.root, "clip.mp4"), "overwritten");
  const input = {
    projectId: randomUUID(),
    threadId: randomUUID(),
    artifactId: job.artifact.id,
    variant: "playback" as const,
    offset: 2,
    length: 4,
  };
  expect(
    Buffer.from((await readVideoArtifact(f.storage, job.artifact, input)).bytes).toString(),
  ).toBe("igin");
  expect(await readFile(join(f.storage, `video-${job.artifact.id}`, "original"), "utf8")).toBe(
    "original-video",
  );
  await rm(join(f.storage, `video-${job.artifact.id}`, "original"));
  await symlink(join(f.root, "clip.mp4"), join(f.storage, `video-${job.artifact.id}`, "original"));
  await expect(readVideoArtifact(f.storage, job.artifact, input)).rejects.toThrow();
});
test("source traversal and symlinks cannot escape the checkout", async () => {
  let calls = 0;
  const f = await fixture(async (input) => {
    calls++;
    return prepared(input);
  });
  const outside = await realpath(await mkdtemp(join(tmpdir(), "tidy-video-outside-")));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "clip.mp4"), "private");
  await symlink(join(outside, "clip.mp4"), join(f.root, "linked.mp4"));
  for (const href of [join(outside, "clip.mp4"), "./linked.mp4"]) {
    const job = enqueue(f, href);
    await job.done;
    expect(job.artifact.status).toBe("failed");
    expect(job.artifact.original).toBeUndefined();
  }
  expect(calls).toBe(0);
});
test("one encoder runs at a time and queued cancellation never starts a second encode", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let count = 0;
  const f = await fixture(async (input) => {
    count++;
    started.resolve();
    await release.promise;
    return prepared(input);
  });
  await writeFile(join(f.root, "clip.mp4"), "video");
  const first = enqueue(f, "./clip.mp4");
  await started.promise;
  const second = enqueue(f, "./clip.mp4");
  f.pipeline.cancel(second.artifact.id);
  expect(second.artifact.status).toBe("queued");
  release.resolve();
  await Promise.all([first.done, second.done]);
  expect(count).toBe(1);
  expect(second.artifact.status).toBe("cancelled");
});

test("shutdown preserves a queued original and recovery does not require the source again", async () => {
  const started = Promise.withResolvers<void>();
  const f = await fixture(async ({ signal }) => {
    started.resolve();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
    );
    throw new Error("unreachable");
  });
  await writeFile(join(f.root, "clip.mp4"), "original-video");
  const job = enqueue(f, "./clip.mp4");
  await started.promise;
  await f.pipeline.close();
  expect(job.artifact.status).toBe("queued");
  expect(job.artifact.original?.size).toBe(14);
  await rm(join(f.root, "clip.mp4"));
  const recovery = new VideoArtifacts(prepared);
  cleanups.push(() => recovery.close());
  const recovered = Promise.withResolvers<void>();
  recovery.enqueue({
    artifact: job.artifact,
    root: f.root,
    storage: async () => f.storage,
    update: async (patch) => {
      Object.assign(job.artifact, patch);
      if (job.artifact.status === "ready" || job.artifact.status === "failed") recovered.resolve();
    },
  });
  await recovered.promise;
  expect(job.artifact.status).toBe("ready");
});
