import { expect, test } from "bun:test";
import { thumbnailIsCurrent, thumbnailVersion } from "@/lib/design/thumbnail-version";
import { cachedThumbnail, cacheThumbnail, clearThumbnailCache } from "./thumbnail-cache";
import { prepareThumbnail, queueThumbnail, uploadThumbnail } from "./thumbnail-queue";

test("renderer upgrades refresh opaque previews without losing document revision ordering", () => {
  const version = "3:2026-10-03T12:00:00.000Z";
  expect(thumbnailIsCurrent(version, version)).toBe(false);
  expect(thumbnailIsCurrent(thumbnailVersion(version), version)).toBe(true);
  expect(thumbnailIsCurrent(thumbnailVersion(version), "4:2026-10-03T12:00:00.000Z")).toBe(false);
  expect(thumbnailIsCurrent(thumbnailVersion(version), "3:2026-10-03T12:00:01.000Z")).toBe(false);
  expect(thumbnailIsCurrent(thumbnailVersion(version), "2:2026-10-03T12:00:00.000Z")).toBe(true);
});

test("preview reuse is user scoped, bounded and immune to late older uploads", () => {
  clearThumbnailCache();
  const value = {
    version: "2:2026-10-03T12:00:00.000Z",
    blob: new Blob(["preview"]),
    persisted: false,
  };
  cacheThumbnail("owner", "file", value);
  expect(cachedThumbnail("other-user", "file")).toBeUndefined();
  expect(cachedThumbnail(undefined, "file")).toBeUndefined();
  cacheThumbnail("owner", "file", {
    ...value,
    version: "1:2026-10-03T12:00:00.000Z",
    persisted: true,
  });
  expect(cachedThumbnail("owner", "file")).toBe(value);
  for (let i = 0; i < 64; i++) cacheThumbnail("owner", `file-${i}`, value);
  expect(cachedThumbnail("owner", "file")).toBeUndefined();
  clearThumbnailCache();
  expect(cachedThumbnail("owner", "file-63")).toBeUndefined();
});

test("large previews cannot make the reusable cache exceed its byte budget", () => {
  clearThumbnailCache();
  const value = {
    version: "1:2026-10-03T12:00:00.000Z",
    blob: new Blob([new Uint8Array(4_000_001)]),
    persisted: true,
  };
  cacheThumbnail("owner", "first", value);
  cacheThumbnail("owner", "second", value);
  expect(cachedThumbnail("owner", "first")).toBeUndefined();
  expect(cachedThumbnail("owner", "second")).toBe(value);
  clearThumbnailCache();
});

test("snapshot preparation overlaps while slow uploads cannot occupy the render slot", async () => {
  const signal = new AbortController().signal;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  const first = prepareThumbnail(async () => {
    started++;
    await gate;
  }, signal);
  const second = prepareThumbnail(async () => {
    started++;
    await gate;
  }, signal);
  const third = prepareThumbnail(async () => {
    started++;
  }, signal);
  const upload = uploadThumbnail(() => gate, signal);
  await queueThumbnail(async () => {
    expect(started).toBe(2);
  }, signal);
  release();
  await Promise.all([first, second, third, upload]);
  expect(started).toBe(3);
});

test("canceling an obsolete waiting render releases its queue entry immediately", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = queueThumbnail(() => gate, new AbortController().signal);
  const obsolete = new AbortController();
  let called = false;
  const waiting = queueThumbnail(async () => {
    called = true;
  }, obsolete.signal);
  obsolete.abort();
  await expect(waiting).rejects.toThrow();
  release();
  await running;
  await queueThumbnail(async () => {}, new AbortController().signal);
  expect(called).toBe(false);
});
