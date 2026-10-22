import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CloudAuth, CloudHTTPError } from "./cloud-auth";
import { HTTPCloudRemote } from "./cloud-remote";
const remote = (request: () => Promise<Response>) =>
  new HTTPCloudRemote({ request } as unknown as CloudAuth);

test("revision manifests are bounded and use one metadata request", async () => {
  let calls = 0;
  const fileId = randomUUID();
  const api = new HTTPCloudRemote({
    request: async (path: string, init: RequestInit) => {
      calls++;
      expect(path).toBe("/api/desktop/manifest");
      expect(JSON.parse(String(init.body))).toEqual({ fileIds: [fileId] });
      return Response.json([{ fileId, revision: 4, name: "Design", canEdit: true }]);
    },
  } as unknown as CloudAuth);
  expect((await api.manifest([fileId]))[0].revision).toBe(4);
  await expect(api.manifest(Array.from({ length: 1001 }, () => randomUUID()))).rejects.toThrow();
  expect(calls).toBe(1);
});

test("thumbnail reads only return bounded PNG data URLs", async () => {
  const valid = Buffer.from("89504e470d0a1a0a", "hex");
  expect(
    await remote(
      async () => new Response(valid, { headers: { "Content-Type": "image/png" } }),
    ).thumbnail(randomUUID()),
  ).toBe(`data:image/png;base64,${valid.toString("base64")}`);
  expect(
    await remote(
      async () => new Response("<html>", { headers: { "Content-Type": "text/html" } }),
    ).thumbnail(randomUUID()),
  ).toBeNull();
  expect(
    await remote(
      async () => new Response("wrong", { headers: { "Content-Type": "image/png" } }),
    ).thumbnail(randomUUID()),
  ).toBeNull();
});
test("oversized thumbnail streams are cancelled rather than buffered indefinitely", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(1_000_001));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    remote(
      async () => new Response(stream, { headers: { "Content-Type": "image/png" } }),
    ).thumbnail(randomUUID()),
  ).rejects.toThrow("too large");
  expect(cancelled).toBe(true);
});
test("missing previews fall back quietly while authorization failures remain failures", async () => {
  expect(
    await remote(async () => {
      throw new CloudHTTPError(404);
    }).thumbnail(randomUUID()),
  ).toBeNull();
  await expect(
    remote(async () => {
      throw new CloudHTTPError(401);
    }).thumbnail(randomUUID()),
  ).rejects.toThrow();
});
