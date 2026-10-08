import { expect, spyOn, test } from "bun:test";
import { handleRequest, requestDeadline } from "./request-boundary";
import {
  assertRequestActive,
  requestPhases,
  requestSignal,
  traceRequestPhase,
} from "./request-lifecycle";

test("a stalled handler returns 503, cancels its work and reports the pending phase", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let signal!: AbortSignal;
  const reports: unknown[] = [];
  try {
    const response = await handleRequest(
      new Request("https://test/api/auth/get-session?token=private"),
      async (request) => {
        signal = request.signal;
        return traceRequestPhase("auth_api", () => new Promise<Response>(() => {}));
      },
      10,
      async (_error, details) => {
        reports.push(details);
      },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(JSON.stringify({ error: "temporarily_unavailable" }));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(signal.aborted).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      event: "request_timed_out",
      phase: "routing,auth_api",
      route: "/api/auth/get-session",
    });
    expect(JSON.stringify(reports)).not.toContain("private");
    // A later invocation must not inherit the canceled context.
    const next = await handleRequest(new Request("https://test/login"), async () => {
      assertRequestActive();
      return new Response("ok");
    });
    expect(await next.text()).toBe("ok");
    expect(requestSignal()).toBeUndefined();
    expect(requestPhases()).toEqual([]);
  } finally {
    warn.mockRestore();
  }
});

test("a slow browser request has a useful failure page without reflecting its URL", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const response = await handleRequest(
      new Request("https://test/login?token=private", { headers: { accept: "text/html" } }),
      () => new Promise(() => {}),
      5,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Try again");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  } finally {
    warn.mockRestore();
  }
});

test("finite page streams retain their deadline and cancel a blocked source", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let canceled = false;
  try {
    const source = new ReadableStream<Uint8Array>(
      {
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = await handleRequest(
      new Request("https://test/files"),
      async () => new Response(source, { headers: { "content-type": "text/x-component" } }),
      10,
    );
    await expect(response.text()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(canceled).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

test("completed headers preserve SSE and non-page response bodies", async () => {
  const source = new Response("data: hello\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
  const result = await handleRequest(new Request("https://test/api/mcp"), async () => source, 5);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(result).toBe(source);
  expect(await result.text()).toBe("data: hello\n\n");
});

test("page cancellation propagates without prefetching or buffering its source", async () => {
  let pulls = 0;
  let canceled = false;
  let signal!: AbortSignal;
  const source = new ReadableStream(
    {
      pull() {
        pulls++;
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const response = await handleRequest(new Request("https://test/files"), async (request) => {
    signal = request.signal;
    return new Response(source, { headers: { "content-type": "text/html" } });
  });
  expect(pulls).toBe(0);
  await response.body!.cancel();
  expect(signal.aborted).toBe(true);
  expect(canceled).toBe(true);
});

test("ordinary failures propagate and read deadlines do not apply to edit mutations", async () => {
  const error = new Error("failure");
  await expect(
    handleRequest(new Request("https://test/files"), async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(requestDeadline(new Request("https://test/api/files/id/changes"))).toBe(8000);
  expect(
    requestDeadline(new Request("https://test/api/files/id/changes", { method: "POST" })),
  ).toBe(20_000);
});
