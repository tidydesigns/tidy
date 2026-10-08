import { expect, spyOn, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import {
  analyticsIdentity,
  createErrorReporter,
  safeServerError,
  serverErrorCategory,
} from "./posthog-server";

test("analytics correlation reads only this project's cookie and handles malformed values", () => {
  const headers = new Headers({
    cookie: `auth=secret; ph_other_posthog=${encodeURIComponent('{"distinct_id":"wrong"}')}; ph_test_posthog=${encodeURIComponent('{"distinct_id":"person-id","private":"secret"}')}`,
  });
  expect(analyticsIdentity(headers, "test")).toBe("person-id");
  expect(
    analyticsIdentity(new Headers({ cookie: "ph_test_posthog=%garbage" }), "test"),
  ).toBeUndefined();
  expect(
    analyticsIdentity(new Headers({ cookie: "ph_test_posthog=null" }), "test"),
  ).toBeUndefined();
});

test("server reports remove sensitive error messages and properties while retaining code locations", () => {
  const original = new TypeError("SQL contains secret@example.test");
  original.stack =
    "TypeError: SQL contains secret@example.test\n    at query (https://app.test/chunk.js?token=secret:2:3)\n    at render (/app/page.tsx:12:3)";
  const safe = safeServerError(original, "server_request_failed");
  expect(safe.name).toBe("TypeError");
  expect(safe.stack).toContain("/app/page.tsx:12:3");
  expect(safe.stack).not.toMatch(/secret|token|SQL/);
  expect(original.message).toContain("secret@example.test");
});

test("Worker reports reach the SDK transport under waitUntil without blocking responses", async () => {
  const payloads: string[] = [];
  let finishFetch!: () => void;
  const transport = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    const body = init?.body;
    payloads.push(body instanceof Uint8Array ? gunzipSync(body).toString() : String(body));
    await new Promise<void>((resolve) => {
      finishFetch = resolve;
    });
    return new Response('{"status":1}', { status: 200 });
  }) as typeof fetch);
  const tasks: Promise<unknown>[] = [];
  try {
    const report = createErrorReporter(
      new Headers({ "cf-ray": "test-ray", authorization: "secret-auth", cookie: "auth=private" }),
      {
        key: "test-key",
        host: "https://posthog.invalid",
        release: "test-release",
        deploymentId: "test-deployment",
        waitUntil: (task) => {
          tasks.push(task);
        },
      },
    );
    await report(new Error("private database parameters"), {
      source: "worker",
      event: "request_stalled",
      route: "/files",
      phase: "handler",
      elapsedMs: 10000,
    });
    expect(tasks).toHaveLength(1);
    // Delivery may start on the next microtask, but the request path has returned.
    for (let i = 0; i < 20 && !payloads.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(payloads).toHaveLength(1);
    const data = payloads.join("\n");
    expect(data).toContain("$exception");
    expect(data).toContain("test-ray");
    expect(data).toContain("test-release");
    expect(data).toContain("test-deployment");
    expect(data).toContain("tidy:request_stalled:/files:handler");
    expect(data).not.toMatch(/private database|secret-auth|auth=private/);
    finishFetch();
    await Promise.all(tasks);
  } finally {
    finishFetch?.();
    transport.mockRestore();
  }
});

test("telemetry transport failures are contained", async () => {
  const transport = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("private transport failure"),
  );
  const warnings: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((value) => {
    warnings.push(String(value));
  });
  try {
    await createErrorReporter(new Headers(), { key: "test-key", host: "https://posthog.invalid" })(
      new Error("original"),
      {
        source: "next",
        event: "server_request_failed",
      },
    );
    expect(warnings.join("\n")).toContain("error_reporting_failed");
    expect(warnings.join("\n")).not.toContain("private");
  } finally {
    transport.mockRestore();
    warn.mockRestore();
  }
});

test("safe categories distinguish actionable server failures without exposing provider details", () => {
  const timeout = Object.assign(new Error("private connection details"), { code: "ETIMEDOUT" });
  expect(serverErrorCategory(timeout)).toBe("connection_timeout");
  expect(safeServerError(timeout, "server_request_failed").message).toBe(
    "server_request_failed: connection_timeout",
  );
  expect(
    serverErrorCategory(new Error("Cannot perform I/O on behalf of a different request")),
  ).toBe("cross_request_io");
  const privateCode = Object.assign(new Error("secret"), { code: "private-value" });
  expect(serverErrorCategory(privateCode)).toBe("unknown");
  expect(safeServerError(privateCode, "server_request_failed").stack).not.toMatch(
    /secret|private-value/,
  );
});
