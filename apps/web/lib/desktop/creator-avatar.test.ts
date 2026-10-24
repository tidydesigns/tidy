import { expect, mock, test } from "bun:test";
mock.module("server-only", () => ({}));
const { providerAvatarURL, boundedAvatarResponse } = await import("./creator-avatar");

test("native avatar proxy only fetches HTTPS images from configured sign-in providers", () => {
  for (const url of [
    "https://avatars.githubusercontent.com/u/1",
    "https://lh3.googleusercontent.com/photo",
  ])
    expect(providerAvatarURL(url)?.href).toBe(url);
  for (const url of [
    "http://lh3.googleusercontent.com/photo",
    "https://lh3.googleusercontent.com.evil.test/photo",
    "https://user:pass@avatars.githubusercontent.com/u/1",
    "https://avatars.githubusercontent.com:8443/u/1",
    "https://127.0.0.1/photo",
    "file:///etc/passwd",
    "data:image/png;base64,AAAA",
    "/api/avatars/user/id",
  ])
    expect(providerAvatarURL(url)).toBeNull();
});

test("native avatar responses validate signatures and cancel unsupported or oversized streams", async () => {
  const signal = new AbortController().signal;
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const valid = await boundedAvatarResponse(
    new Response(png, { headers: { "Content-Type": "image/png" } }),
    signal,
  );
  expect(valid.status).toBe(200);
  expect(valid.headers.get("cache-control")).toBe("private, no-store");
  expect(Buffer.from(await valid.arrayBuffer())).toEqual(png);
  for (const [body, type] of [
    ["<svg/>", "image/svg+xml"],
    ["html", "image/png"],
  ])
    expect(
      (
        await boundedAvatarResponse(
          new Response(body, { headers: { "Content-Type": type } }),
          signal,
        )
      ).status,
    ).toBe(404);
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(1_000_001));
    },
    cancel() {
      cancelled = true;
    },
  });
  expect(
    (
      await boundedAvatarResponse(
        new Response(stream, { headers: { "Content-Type": "image/png" } }),
        signal,
      )
    ).status,
  ).toBe(404);
  expect(cancelled).toBe(true);
  const abort = new AbortController();
  abort.abort();
  expect(
    (
      await boundedAvatarResponse(
        new Response(png, { headers: { "Content-Type": "image/png" } }),
        abort.signal,
      )
    ).status,
  ).toBe(404);
});
