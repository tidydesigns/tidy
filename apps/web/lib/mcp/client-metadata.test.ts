import { expect, mock, test } from "bun:test";
import { createWorkerMetadataFetch, fetchClientMetadataResource } from "./client-metadata";

function transport(response = Response.json({ client_name: "Test" })) {
  const guard = mock(async (request: Request) => {
    expect(request.method).toBe("POST");
    return response;
  });
  return { guard, fetch: createWorkerMetadataFetch(guard) };
}

test("Workers use the shared public-metadata guard and propagate cancellation", async () => {
  const { guard, fetch } = transport();
  const controller = new AbortController();
  const details: unknown = await (
    await fetch("https://client.example/metadata.json", { signal: controller.signal })
  ).json();
  expect(details).toEqual({ client_name: "Test" });
  const request = guard.mock.calls[0][0];
  expect(request.method).toBe("POST");
  const payload: unknown = await request.json();
  expect(payload).toEqual({ url: "https://client.example/metadata.json" });
  controller.abort();
  expect(request.signal.aborted).toBe(true);
});

test.each([
  "http://client.example/metadata.json",
  "https://localhost/metadata.json",
  "https://127.0.0.1/metadata.json",
  "https://10.0.0.1/metadata.json",
  "https://169.254.169.254/metadata.json",
  "https://[::1]/metadata.json",
  "https://user:password@client.example/metadata.json",
])("Workers reject unsafe metadata URLs before invoking the guard: %s", async (url) => {
  const { guard, fetch } = transport();
  await expect(fetch(url)).rejects.toThrow();
  expect(guard).not.toHaveBeenCalled();
});

test("Workers reject writes and propagate guard failures", async () => {
  const { guard, fetch } = transport();
  await expect(fetch("https://client.example/metadata.json", { method: "POST" })).rejects.toThrow(
    "GET and HEAD",
  );
  expect(guard).not.toHaveBeenCalled();
  guard.mockRejectedValue(new TypeError("guard unavailable"));
  await expect(fetch("https://client.example/metadata.json")).rejects.toThrow("guard unavailable");
});

test("Node retains the pinned DNS transport", async () => {
  await expect(fetchClientMetadataResource("http://client.example/metadata.json")).rejects.toThrow(
    "CIMD Node transport requires an HTTPS URL",
  );
});

test.each([301, 302, 303, 307, 308])(
  "Workers reject unexpected guard redirect status %s",
  async (status) => {
    const { guard, fetch } = transport(
      new Response(null, { status, headers: { Location: "https://127.0.0.1/private" } }),
    );
    await expect(fetch("https://client.example/metadata.json")).rejects.toThrow(
      "redirects are not allowed",
    );
    expect(guard).toHaveBeenCalledTimes(1);
  },
);
