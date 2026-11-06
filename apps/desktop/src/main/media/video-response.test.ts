import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  decodeVideoChunk,
  issueVideoURL,
  nativeVideoResponse,
  revokeVideoURLs,
  videoRange,
  videoResponse,
} from "./video-response";
import { VIDEO_CHUNK_BYTES, type VideoRead } from "../../shared/contracts/video-artifacts";

const reference = { projectId: randomUUID(), threadId: randomUUID(), artifactId: randomUUID() };
const path = `http://localhost/__tidy/videos/${reference.projectId}/${reference.threadId}/${reference.artifactId}/playback`;
test("single ranges handle suffixes and reject malformed or unsatisfiable requests", () => {
  expect(videoRange("bytes=-5", 10)).toEqual({ start: 5, end: 9, partial: true });
  expect(videoRange("bytes=3-99", 10)).toEqual({ start: 3, end: 9, partial: true });
  for (const range of [
    "bytes=10-",
    "bytes=-0",
    "bytes=2-1",
    "bytes=0-1,3-4",
    "bytes=",
    "bytes=9007199254740993-",
  ])
    expect(videoRange(range, 10)).toBeNull();
});
test("streaming is bounded, seeks without preceding reads and cancels without draining", async () => {
  const calls: VideoRead[] = [];
  const size = VIDEO_CHUNK_BYTES * 10;
  const read = async (input: VideoRead) => {
    calls.push(input);
    return {
      size,
      mimeType: "video/mp4" as const,
      name: "demo.mp4",
      bytes: Buffer.alloc(input.length, 7),
    };
  };
  const response = await videoResponse(
    new Request(path, { headers: { Range: `bytes=${VIDEO_CHUNK_BYTES}-` } }),
    read,
  );
  expect(response.status).toBe(206);
  expect(calls).toHaveLength(1);
  expect(response.headers.get("Content-Range")).toBe(
    `bytes ${VIDEO_CHUNK_BYTES}-${size - 1}/${size}`,
  );
  const reader = response.body!.getReader();
  expect((await reader.read()).value!.length).toBe(256 * 1024);
  expect((await reader.read()).value!.length).toBe(VIDEO_CHUNK_BYTES);
  expect(calls[2].offset).toBe(VIDEO_CHUNK_BYTES + 256 * 1024);
  expect(calls[1].offset).toBe(VIDEO_CHUNK_BYTES);
  await reader.cancel();
  expect(calls).toHaveLength(3);
  const head = await videoResponse(new Request(path, { method: "HEAD" }), read);
  expect(head.body).toBeNull();
  const invalid = await videoResponse(
    new Request(path, { headers: { Range: "bytes=9999999999-" } }),
    read,
  );
  expect(invalid.status).toBe(416);
});
test("authorization failures and revoked native capabilities never serve media", async () => {
  const denied = async () => {
    throw new Error("denied");
  };
  expect((await videoResponse(new Request(path), denied)).status).toBe(404);
  const read = async (input: VideoRead) => ({
    size: 10,
    mimeType: "video/mp4" as const,
    name: 'a".mp4',
    bytes: Buffer.alloc(input.length),
  });
  const url = issueVideoURL(123, reference, "original", read);
  const response = await nativeVideoResponse(new Request(url));
  expect(response.headers.get("Content-Disposition")).toContain("attachment;");
  revokeVideoURLs(123);
  expect((await nativeVideoResponse(new Request(url))).status).toBe(404);
  await expect(response.arrayBuffer()).rejects.toThrow();
});
test("changed or oversized chunk data terminates the stream", async () => {
  const response = await videoResponse(new Request(path), async (input) => ({
    size: 10,
    mimeType: "video/mp4",
    name: "a.mp4",
    bytes: Buffer.alloc(input.length ? 11 : 0),
  }));
  await expect(response.arrayBuffer()).rejects.toThrow();
});

test("remote decoding rejects malformed base64 and retains metadata", () => {
  const chunk = { size: 4, mimeType: "video/mp4" as const, name: "demo.mp4", base64: "dGVzdA==" };
  expect(decodeVideoChunk(chunk).bytes).toEqual(Buffer.from("test"));
  expect(decodeVideoChunk(chunk).name).toBe(chunk.name);
  expect(() => decodeVideoChunk({ ...chunk, base64: "dGVzdA==!" })).toThrow();
});
