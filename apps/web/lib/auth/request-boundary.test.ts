import { expect, spyOn, test } from "bun:test";
import { handleAuthRequest, isAuthRequest } from "./request-boundary";
import { assertRequestActive, onRequestCanceled, traceAuthOperation } from "./request-lifecycle";

for (const phase of [
  "routing",
  "auth_initialization",
  "auth_endpoint",
  "database_connect",
  "database_query",
  "client_metadata",
  "rate_limit",
] as const) {
  test(`a stalled ${phase} returns a private retry page and cancels resources`, async () => {
    let canceled = false;
    const logs = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const start = performance.now();
      const request = new Request(
        "https://app.example/api/auth/oauth2/authorize?state=secret-state&code=secret-code",
        { headers: { Accept: "text/html", "cf-ray": "test-ray" } },
      );
      const response = await handleAuthRequest(
        request,
        () =>
          traceAuthOperation(phase, () => {
            onRequestCanceled(() => {
              canceled = true;
            });
            return new Promise<Response>(() => {});
          }),
        20,
      );
      expect(performance.now() - start).toBeLessThan(500);
      expect(response.status).toBe(503);
      expect(canceled).toBe(true);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      const body = await response.text();
      expect(body).toContain("Try again");
      expect(body).not.toContain("secret-state");
      expect(body).not.toContain("secret-code");
      expect(JSON.stringify(logs.mock.calls)).toContain(phase);
      expect(JSON.stringify(logs.mock.calls)).not.toContain("secret-state");
    } finally {
      logs.mockRestore();
    }
  });
}

test("an incomplete auth response body is canceled before headers are sent", async () => {
  let canceled = false;
  const logs = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const response = await handleAuthRequest(
      new Request("https://app.example/login"),
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
            },
            cancel() {
              canceled = true;
            },
          }),
        ),
      20,
    );
    expect(response.status).toBe(503);
    expect(canceled).toBe(true);
    expect(await response.text()).not.toContain("partial");
  } finally {
    logs.mockRestore();
  }
});

test("a timed-out handler cannot begin a later write; another request still completes", async () => {
  let release!: () => void;
  let writes = 0;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const logs = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const response = await handleAuthRequest(
      new Request("https://app.example/api/auth/update-user", { method: "POST" }),
      async () => {
        await stalled;
        assertRequestActive();
        writes++;
        return Response.json({ success: true });
      },
      20,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "temporarily_unavailable" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(writes).toBe(0);
    const second = await handleAuthRequest(
      new Request("https://app.example/api/auth/get-session"),
      async () => Response.json(null),
      100,
    );
    expect(second.status).toBe(200);
  } finally {
    logs.mockRestore();
  }
});

test("successful redirects and multiple session cookies survive the boundary", async () => {
  const headers = new Headers({ Location: "http://127.0.0.1:1234/callback?code=one-time" });
  headers.append("Set-Cookie", "first=1; HttpOnly");
  headers.append("Set-Cookie", "second=2; HttpOnly");
  const response = await handleAuthRequest(
    new Request("https://app.example/api/auth/oauth2/authorize"),
    async () => new Response(null, { status: 302, headers }),
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toContain("127.0.0.1");
  expect(response.headers.getSetCookie()).toHaveLength(2);
  expect(isAuthRequest("/api/mcp")).toBe(false);
  expect(isAuthRequest("/api/auth/oauth2/authorize")).toBe(true);
});
