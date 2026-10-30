import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readVideoChunk } from "./video-preview";
import {
  MAX_VIDEO_BYTES,
  VIDEO_CHUNK_BYTES,
  videoChunkSchema,
} from "../../shared/contracts/video-preview";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "video-preview-"));
  directories.push(directory);
  const root = join(directory, "project");
  await mkdir(root);
  return { root: await realpath(root), directory };
}

test("recordings transfer in bounded chunks with an unchanged revision", async () => {
  const { root } = await fixture();
  const bytes = Buffer.alloc(VIDEO_CHUNK_BYTES + 47, 19);
  await writeFile(join(root, "feature demo.MP4"), bytes);
  const first = await readVideoChunk({ root, href: "feature%20demo.MP4", offset: 0 });
  expect(videoChunkSchema.parse(first).mimeType).toBe("video/mp4");
  expect(Buffer.from(first.data, "base64")).toEqual(bytes.subarray(0, VIDEO_CHUNK_BYTES));
  const second = await readVideoChunk({
    root,
    href: "feature%20demo.MP4",
    offset: VIDEO_CHUNK_BYTES,
    revision: first.revision,
  });
  expect(second.revision).toBe(first.revision);
  expect(Buffer.from(second.data, "base64")).toEqual(bytes.subarray(VIDEO_CHUNK_BYTES));
});

test("absolute paths and file URLs inside the execution folder are supported", async () => {
  const { root } = await fixture();
  const path = join(root, "demo.webm");
  await writeFile(path, "recording");
  for (const href of [path, `file://${path}`, "./demo.webm"]) {
    expect((await readVideoChunk({ root, href, offset: 0 })).mimeType).toBe("video/webm");
  }
});

test("traversal and symlinks cannot expose files outside the project", async () => {
  const { root, directory } = await fixture();
  const outside = join(directory, "private.mp4");
  await writeFile(outside, "private");
  await symlink(outside, join(root, "escape.mp4"));
  await symlink(directory, join(root, "linked"));
  for (const href of [
    outside,
    "../private.mp4",
    "%2e%2e/private.mp4",
    "escape.mp4",
    "linked/private.mp4",
  ]) {
    await expect(readVideoChunk({ root, href, offset: 0 })).rejects.toThrow("project folder");
  }
});

test("directories, unsupported links, empty and oversized videos are rejected", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "directory.mp4"));
  await writeFile(join(root, "empty.mp4"), "");
  await writeFile(join(root, "large.mp4"), "");
  await truncate(join(root, "large.mp4"), MAX_VIDEO_BYTES + 1);
  for (const href of [
    "https://example.com/demo.mp4",
    "javascript:alert(1)",
    "notes.txt",
    "directory.mp4",
  ]) {
    await expect(readVideoChunk({ root, href, offset: 0 })).rejects.toThrow();
  }
  await expect(readVideoChunk({ root, href: "empty.mp4", offset: 0 })).rejects.toThrow("empty");
  await expect(readVideoChunk({ root, href: "large.mp4", offset: 0 })).rejects.toThrow("128 MiB");
});

test("changed recordings and invalid continuation offsets fail instead of mixing bytes", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "demo.mp4"), "first recording");
  const first = await readVideoChunk({ root, href: "demo.mp4", offset: 0 });
  await writeFile(join(root, "demo.mp4"), "replacement recording");
  await expect(
    readVideoChunk({ root, href: "demo.mp4", offset: 1, revision: first.revision }),
  ).rejects.toThrow("changed");
  await expect(readVideoChunk({ root, href: "demo.mp4", offset: 1 })).rejects.toThrow("changed");
  const revision = (await readVideoChunk({ root, href: "demo.mp4", offset: 0 })).revision;
  for (const offset of [-1, 0.5, 1000]) {
    await expect(
      readVideoChunk({
        root,
        href: "demo.mp4",
        offset,
        revision,
      }),
    ).rejects.toThrow("position");
  }
});
