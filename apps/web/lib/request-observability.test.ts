import { expect, test } from "bun:test";
import { normalizedRoute, observeRequest } from "./request-observability";

test("request diagnostics exclude credentials and identifiers", () => {
  expect(normalizedRoute("https://example.test/api/files/private-file/live?ticket=secret")).toBe(
    "/api/files/:id/live",
  );
  expect(normalizedRoute("https://example.test/user@example.test")).toBe("/:id");
  expect(normalizedRoute("https://example.test/api/auth/get-session")).toBe(
    "/api/auth/get-session",
  );
});

test("request observation preserves response bodies and headers", async () => {
  const response = new Response("content", {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
  const result = await observeRequest(
    new Request("https://example.test/files"),
    async () => response,
  );
  expect(result).toBe(response);
  expect(await result.text()).toBe("content");
  expect(result.headers.get("Cache-Control")).toBe("no-store");
});

// Exercise the actual stream lifecycle rather than just Response creation.
test("RSC diagnostics distinguish headers, a stalled partial body, and completion", async () => {
  const { spyOn } = await import("bun:test");
  const records: string[] = [];
  const info = spyOn(console, "info").mockImplementation((message) => {
    records.push(String(message));
  });
  const warn = spyOn(console, "warn").mockImplementation((message) => {
    records.push(String(message));
  });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const reports: unknown[] = [];
  const source = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const response = await observeRequest(
    new Request("https://example.test/files?folder=secret", {
      headers: { rsc: "1", "cf-ray": "test-ray", cookie: "private" },
    }),
    async () =>
      new Response(source, {
        headers: { "Content-Type": "text/x-component", "Cache-Control": "no-store" },
      }),
    async (_error, details) => {
      reports.push(details);
    },
  );
  const reader = response.body!.getReader();
  try {
    expect(records.map((record) => JSON.parse(record).event)).toEqual([
      "request_started",
      "response_headers",
    ]);
    const chunk = new TextEncoder().encode("private page content");
    controller.enqueue(chunk);
    expect((await reader.read()).value).toEqual(chunk);
    await new Promise((resolve) => setTimeout(resolve, 10_020));
    expect(JSON.parse(records.at(-1)!)).toMatchObject({
      event: "request_stalled",
      phase: "body",
      bytes: chunk.length,
      kind: "rsc",
      ray: "test-ray",
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      source: "worker",
      event: "request_stalled",
      phase: "body",
      route: "/files",
    });
    expect(JSON.stringify(reports)).not.toMatch(/secret|private/);
    controller.close();
    expect((await reader.read()).done).toBe(true);
    expect(JSON.parse(records.at(-1)!)).toMatchObject({
      event: "response_body_completed",
      bytes: chunk.length,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(records.join("\n")).not.toMatch(/secret|private|page content/);
  } finally {
    await reader.cancel();
    info.mockRestore();
    warn.mockRestore();
  }
}, 15_000);

test("page stream errors propagate and are logged without the error's private message", async () => {
  const { spyOn } = await import("bun:test");
  const records: string[] = [];
  const info = spyOn(console, "info").mockImplementation(() => {});
  const errorLog = spyOn(console, "error").mockImplementation((message) => {
    records.push(String(message));
  });
  const failure = new Error("private database details");
  try {
    const source = new ReadableStream({
      pull(controller) {
        controller.error(failure);
      },
    });
    const response = await observeRequest(
      new Request("https://example.test/files"),
      async () => new Response(source, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    );
    await expect(response.text()).rejects.toBe(failure);
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]).event).toBe("response_body_failed");
    expect(records[0]).not.toContain("private");
  } finally {
    info.mockRestore();
    errorLog.mockRestore();
  }
});

test("canceling a page cancels the source without reading ahead", async () => {
  const { spyOn } = await import("bun:test");
  const records: string[] = [];
  const info = spyOn(console, "info").mockImplementation((message) => {
    records.push(String(message));
  });
  let pulls = 0;
  let canceled: unknown;
  try {
    const source = new ReadableStream(
      {
        pull() {
          pulls++;
        },
        cancel(reason) {
          canceled = reason;
        },
      },
      { highWaterMark: 0 },
    );
    const response = await observeRequest(
      new Request("https://example.test/files"),
      async () => new Response(source, { headers: { "Content-Type": "text/html" } }),
    );
    expect(pulls).toBe(0);
    await response.body!.cancel("left page");
    expect(canceled).toBe("left page");
    expect(JSON.parse(records.at(-1)!).event).toBe("response_body_canceled");
    expect(records.join("\n")).not.toContain("left page");
  } finally {
    info.mockRestore();
  }
});
