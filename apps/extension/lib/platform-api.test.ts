import { expect, test } from "bun:test";
import { MAX_CAPTURE_BYTES } from "@tidy/design/web-capture";
import { readPlatformResponse, serializeCaptureRequest, platformRetryAfter } from "./platform-api";

test("responses are bounded by actual UTF-8 bytes even without Content-Length", async () => {
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('"😀😀"'));
    },
    cancel() {
      canceled = true;
    },
  });
  await expect(readPlatformResponse(new Response(body), 8)).rejects.toThrow("too large");
  expect(canceled).toBe(true);
});
test("split UTF-8 sequences are decoded and non-JSON failures are sanitized", async () => {
  const bytes = new TextEncoder().encode('{"value":"😀"}');
  const body = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  expect(await readPlatformResponse(new Response(body))).toEqual({ value: "😀" });
  await expect(
    readPlatformResponse(new Response("<html>internal diagnostic</html>", { status: 502 })),
  ).rejects.toThrow("Tidy is unavailable");
});
test("oversized declared responses cancel without consuming their body", async () => {
  let canceled = false;
  const body = new ReadableStream({
    cancel() {
      canceled = true;
    },
  });
  await expect(
    readPlatformResponse(new Response(body, { headers: { "Content-Length": "1000" } }), 100),
  ).rejects.toThrow("too large");
  expect(canceled).toBe(true);
});
test("outgoing limits use UTF-8 bytes rather than JavaScript string length", () => {
  const text = "😀".repeat(MAX_CAPTURE_BYTES / 4);
  expect(text.length).toBeLessThan(MAX_CAPTURE_BYTES);
  expect(() => serializeCaptureRequest({ text })).toThrow("exceeds 16 MB");
  expect(serializeCaptureRequest({ text: "small" })).toBe('{"text":"small"}');
});
test("Retry-After supports seconds and HTTP dates without unbounded delays", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  expect(platformRetryAfter("60", now)).toBe(60);
  expect(platformRetryAfter("Thu, 29 Oct 2026 12:01:00 GMT", now)).toBe(60);
  expect(platformRetryAfter("999999", now)).toBe(3600);
  expect(platformRetryAfter("invalid", now)).toBe(0);
  expect(platformRetryAfter("Thu, 29 Oct 2026 11:00:00 GMT", now)).toBe(0);
});
