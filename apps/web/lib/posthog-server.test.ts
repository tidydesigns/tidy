import { afterEach, expect, spyOn, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { createErrorReporter, safeServerError, serverErrorCategory } from "./posthog-server";
import * as serverReporting from "./posthog-server";
import { onRequestError } from "../instrumentation";
import { posthogCollectionEnabled, posthogServerErrorsEnabled } from "./posthog-policy";
import { consentCookie, ESSENTIAL_ONLY } from "./privacy/consent";
import { observeRequest } from "./request-observability";
import { PersonalBudgetError } from "./security/personal-budget";
import { OperationBudgetError } from "./security/operation-budget";

const original = { ...process.env };
afterEach(() => {
  for (const key of ["POSTHOG_SERVER_ERRORS_ENABLED", "NEXT_PUBLIC_POSTHOG_ENABLED"]) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});
const runtime = { serverErrorsEnabled: "1", key: "test-key", host: "https://posthog.invalid" };

test.each([
  ["42501", "database_permission_denied"],
  ["42P01", "database_missing_table"],
  ["42703", "database_missing_column"],
  ["42P18", "database_indeterminate_parameter"],
  ["42804", "database_datatype_mismatch"],
  ["25P02", "database_transaction_aborted"],
  ["25006", "database_read_only"],
])("server import diagnostics classify %s without exposing database details", (code, category) => {
  const error = Object.assign(new Error("private SQL and design content"), { code });
  expect(serverErrorCategory(error)).toBe(category);
  const safe = safeServerError(error, "operation_failed");
  expect(safe.message).toBe(`operation_failed: ${category}`);
  expect(safe.message).not.toContain("private");
});
function collector() {
  const bodies: string[] = [];
  const transport = spyOn(globalThis, "fetch").mockImplementation((async (
    _url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const body = init?.body;
    bodies.push(body instanceof Uint8Array ? gunzipSync(body).toString() : String(body));
    return Response.json({ status: 1 });
  }) as unknown as typeof fetch);
  return {
    bodies,
    transport,
    events: () =>
      bodies.flatMap((body) => {
        const data = JSON.parse(body);
        return data.batch ?? [data];
      }),
  };
}

test.each([
  ["/api/auth/oauth2/token?code=private-code", "/api/auth/[...all]", "/api/auth/oauth2/token"],
  ["/api/desktop/manifest", "/api/desktop/[...path]", "/api/desktop/manifest"],
  ["/api/desktop/files/private-file", "/api/desktop/[...path]", "/api/desktop/files/:id"],
])("Next errors identify the sanitized endpoint for %s", async (path, routePath, expected) => {
  const c = collector();
  const reporter = createErrorReporter(runtime);
  const factory = spyOn(serverReporting, "createErrorReporter").mockReturnValue(reporter);
  try {
    await onRequestError(
      new Error("private failure"),
      { path, method: "POST", headers: { authorization: "Bearer private-token" } },
      { routerKind: "App Router", routeType: "route", routePath, revalidateReason: undefined },
    );
    expect(c.events()).toHaveLength(1);
    expect(c.events()[0].properties).toMatchObject({ route: expected, method: "POST" });
    expect(c.bodies.join("")).not.toContain("private");
  } finally {
    factory.mockRestore();
    c.transport.mockRestore();
  }
});

test("independent server switch defaults off and explicit runtime off overrides environment", async () => {
  const c = collector();
  try {
    delete process.env.POSTHOG_SERVER_ERRORS_ENABLED;
    process.env.NEXT_PUBLIC_POSTHOG_ENABLED = "1";
    expect(posthogServerErrorsEnabled()).toBe(false);
    await createErrorReporter({ ...runtime, serverErrorsEnabled: undefined })(
      new Error("private"),
      { source: "next", event: "server_request_failed" },
    );
    process.env.POSTHOG_SERVER_ERRORS_ENABLED = "1";
    expect(posthogServerErrorsEnabled()).toBe(true);
    expect(posthogServerErrorsEnabled("0")).toBe(false);
    await createErrorReporter({ ...runtime, serverErrorsEnabled: "0" })(new Error("private"), {
      source: "next",
      event: "server_request_failed",
    });
    expect(c.bodies).toHaveLength(0);
  } finally {
    c.transport.mockRestore();
  }
});

test.each(["missing", "rejected", "expired", "accepted"])(
  "server failure delivery is independent of %s optional consent",
  async (state) => {
    process.env.NEXT_PUBLIC_POSTHOG_ENABLED = "0";
    const c = collector();
    const tasks: Promise<unknown>[] = [];
    const consent =
      state === "missing"
        ? ""
        : consentCookie(
            state === "accepted"
              ? { analytics: true, replay: true, diagnostics: true }
              : ESSENTIAL_ONLY,
            state === "expired" ? 0 : Date.now(),
          );
    const headers = new Headers({
      cookie: `${consent}; ph_test-key_posthog=${encodeURIComponent(JSON.stringify({ distinct_id: "private-account", $user_state: "identified", $session_id: "private-session", email: "private@example.test" }))}`,
      "cf-ray": "private-ray",
      authorization: "private-token",
    });
    try {
      expect(posthogCollectionEnabled(headers.get("cookie"), "diagnostics")).toBe(false);
      const report = createErrorReporter({ ...runtime, waitUntil: (task) => tasks.push(task) });
      await expect(
        observeRequest(
          new Request("https://app.test/files/private-design?secret=private-value", { headers }),
          async () => {
            throw new Error("private-error");
          },
          report,
        ),
      ).rejects.toThrow("private-error");
      await Promise.all(tasks);
      const event = c.events()[0];
      expect(c.events()).toHaveLength(1);
      expect(event.event).toBe("$exception");
      expect(event.distinct_id ?? event.properties.distinct_id).toBe("tidy-server");
      expect(event.properties).toMatchObject({
        route: "/files/:id",
        telemetry_scope: "server_reliability",
        $process_person_profile: false,
        $geoip_disable: true,
      });
      expect(c.bodies.join("")).not.toMatch(
        /private-|private@|ph_test|authorization|\$session_id|trace_id/,
      );
    } finally {
      c.transport.mockRestore();
    }
  },
);

test("server reports allowlist details, strip sensitive stack context and preserve useful diagnostics", async () => {
  const c = collector();
  try {
    const failure = Object.assign(new TypeError("private SQL query"), {
      code: "ETIMEDOUT",
      cause: new Error("private cause"),
    });
    failure.stack =
      "TypeError: private SQL query\n    at privateFunction (/Users/private-user/app/page.tsx:12:3)\n    at call (https://private-host/chunk.js?token=private-secret:2:3)\n    at privateInline (private-code)";
    await createErrorReporter({
      ...runtime,
      release: "release-123",
      deploymentId: "deployment-456",
    })(failure, {
      source: "next",
      event: "server_request_failed",
      route: "/files/private-file?token=private-token",
      method: "GET",
      phase: "render,private-phase",
      elapsedMs: 12,
      digest: "private-digest",
      // Simulate structurally wider caller data and future accidental additions.
      ...{
        email: "private-email",
        ray: "private-ray",
        trace_id: "private-trace",
        userId: "private-user",
      },
    });
    const event = c.events()[0];
    expect(event.properties).toMatchObject({
      error_category: "connection_timeout",
      $app_version: "release-123",
      deployment_id: "deployment-456",
      phase: "render",
      route: "/files/:id",
    });
    expect(c.bodies.join("")).toContain("page.tsx");
    expect(c.bodies.join("")).not.toMatch(
      /private|Users|SQL|cause|context_line|pre_context|post_context|\"vars\"/,
    );
    expect(event.properties.$exception_list[0].stacktrace.frames[0].lineno).toBe(12);
    expect(event.properties.$exception_list[0].stacktrace.type).toBe("raw");
    expect(event.properties.$exception_list[0].stacktrace.frames[0].platform).toBe(
      "node:javascript",
    );
    for (const frame of event.properties.$exception_list[0].stacktrace.frames)
      expect(frame.function).toBe("<redacted>");
    expect(event.properties.$exception_list[0].mechanism).toMatchObject({
      type: "generic",
      handled: true,
    });
  } finally {
    c.transport.mockRestore();
  }
});

test("anonymous server frames retain the required function field in the SDK wire payload", async () => {
  const c = collector();
  try {
    const failure = new Error("private message");
    failure.stack = "Error: private message\n    at /private/server/chunk.js:12:3";
    await createErrorReporter(runtime)(failure, { source: "next", event: "server_request_failed" });
    expect(c.events()).toHaveLength(1);
    expect(c.events()[0].properties.$exception_list[0].stacktrace).toEqual({
      type: "raw",
      frames: [
        {
          filename: "chunk.js",
          function: "<redacted>",
          lineno: 12,
          colno: 3,
          platform: "node:javascript",
          in_app: true,
        },
      ],
    });
    expect(c.bodies.join("")).not.toContain("private");
  } finally {
    c.transport.mockRestore();
  }
});

test("SDK context cannot attach a person, session, tags or custom properties", async () => {
  const { PostHog } = await import("posthog-node");
  const c = collector();
  const capture = PostHog.prototype.captureExceptionImmediate;
  const enrich = spyOn(PostHog.prototype, "captureExceptionImmediate").mockImplementation(function (
    this: InstanceType<typeof PostHog>,
    ...args: Parameters<typeof capture>
  ) {
    return this.withContext(
      {
        distinctId: "private-person",
        sessionId: "private-session",
        properties: { email: "private@example.test", custom: "private-custom" },
      },
      () => capture.apply(this, args),
    );
  });
  try {
    await createErrorReporter(runtime)(new Error("private"), {
      source: "next",
      event: "server_request_failed",
    });
    expect(c.bodies).toHaveLength(1);
    expect(c.bodies.join("")).not.toContain("private");
    const event = c.events()[0];
    expect(event.distinct_id ?? event.properties.distinct_id).toBe("tidy-server");
  } finally {
    enrich.mockRestore();
    c.transport.mockRestore();
  }
});

test("request-scoped correlation is reused within a reporter and changes between requests", async () => {
  const c = collector();
  try {
    const report = createErrorReporter(runtime);
    for (const event of ["request_stalled", "request_failed"])
      await report(new Error("private"), { source: "worker", event, route: "/files" });
    await createErrorReporter(runtime)(new Error("private"), {
      source: "worker",
      event: "request_failed",
      route: "/files",
    });
    const ids = c.events().map((event) => event.properties.server_report_id);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  } finally {
    c.transport.mockRestore();
  }
});

test("unknown event names are replaced and telemetry endpoints cannot report recursively", async () => {
  const c = collector();
  try {
    const report = createErrorReporter(runtime);
    await report(new Error("private"), {
      source: "next",
      event: "private-event",
      operation: "private-operation",
      route: "/files",
      phase: "private-phase",
    });
    await report(new Error("private"), {
      source: "next",
      event: "request_failed",
      route: "/api/t/e",
    });
    await report(new Error("private"), {
      source: "next",
      event: "request_failed",
      route: "/api/t",
    });
    expect(c.events()).toHaveLength(1);
    expect(c.bodies.join("")).not.toContain("private");
  } finally {
    c.transport.mockRestore();
  }
});

test("Worker delivery uses waitUntil without delaying the response", async () => {
  let finish!: () => void;
  const tasks: Promise<unknown>[] = [];
  const transport = spyOn(globalThis, "fetch").mockImplementation((async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return Response.json({ status: 1 });
  }) as unknown as typeof fetch);
  try {
    await createErrorReporter({ ...runtime, waitUntil: (task) => tasks.push(task) })(
      new Error("private"),
      { source: "worker", event: "request_stalled" },
    );
    expect(tasks).toHaveLength(1);
    for (let i = 0; i < 20 && !finish; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(finish).toBeDefined();
    finish();
    await Promise.all(tasks);
  } finally {
    finish?.();
    transport.mockRestore();
  }
});

test("transport failures are contained without exposing private messages", async () => {
  const transport = spyOn(globalThis, "fetch").mockRejectedValue(new Error("private transport"));
  const warnings: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((value) => {
    warnings.push(String(value));
  });
  try {
    await createErrorReporter(runtime)(new Error("private error"), {
      source: "next",
      event: "server_request_failed",
    });
    expect(warnings.join(" ")).toContain("error_reporting_failed");
    expect(warnings.join(" ")).not.toContain("private");
  } finally {
    transport.mockRestore();
    warn.mockRestore();
  }
});

test("safe categories preserve actionable diagnostics without arbitrary codes or messages", () => {
  expect(serverErrorCategory(Object.assign(new Error("private"), { code: "ETIMEDOUT" }))).toBe(
    "connection_timeout",
  );
  expect(
    serverErrorCategory(new Error("Cannot perform I/O on behalf of a different request")),
  ).toBe("cross_request_io");
  expect(
    safeServerError(Object.assign(new Error("private"), { code: "private" }), "private-event")
      .message,
  ).toBe("server_request_failed");
});

test("wrapped account guard failures retain categories without exporting their causes", async () => {
  const c = collector();
  try {
    const cause = new Error("private-provider-token", {
      cause: new DOMException("private-timeout-details", "TimeoutError"),
    });
    const failure = new PersonalBudgetError(503, { cause });
    expect(failure.cause).toBe(cause);
    expect(failure.message).toBe("Account requests are temporarily unavailable. Try again.");
    await createErrorReporter(runtime)(failure, {
      source: "next",
      event: "server_request_failed",
      route: "/mcp",
      phase: "render",
    });
    expect(c.events()[0].properties.error_category).toBe("timeout");
    expect(c.events()[0].properties.$exception_list).toHaveLength(1);
    expect(c.bodies.join("")).not.toMatch(/private-|provider-token|timeout-details|\"cause\"/);
    const cyclic = new Error("private-cycle");
    cyclic.cause = cyclic;
    expect(serverErrorCategory(cyclic)).toBe("unknown");
    expect(serverErrorCategory(new Error("AUTH_GUARD binding is required"))).toBe(
      "missing_runtime_binding",
    );
  } finally {
    c.transport.mockRestore();
  }
});

test("MCP admission reports retain the guard failure category without exposing private data", async () => {
  const c = collector();
  try {
    const failure = new OperationBudgetError(503, 5, {
      cause: new DOMException("private-guard-details", "TimeoutError"),
    });
    await createErrorReporter(runtime)(failure, {
      source: "operation",
      event: "operation_failed",
      operation: "mcp.admission",
      route: "/api/mcp",
      method: "POST",
      phase: "handler",
    });
    expect(c.events()[0].properties).toMatchObject({
      error_category: "timeout",
      operation: "mcp.admission",
      route: "/api/mcp",
      method: "POST",
      phase: "handler",
    });
    expect(c.bodies.join("")).not.toMatch(/private-|\"cause\"/);
  } finally {
    c.transport.mockRestore();
  }
});

test("non-Error and stackless errors cannot expose the wrapper's machine paths", async () => {
  const c = collector();
  try {
    const stackless = new Error("private-stackless");
    stackless.stack = undefined;
    for (const failure of ["private-value", { message: "private-object" }, stackless]) {
      await createErrorReporter(runtime)(failure, {
        source: "next",
        event: "server_request_failed",
      });
    }
    expect(c.events()).toHaveLength(3);
    expect(c.bodies.join("")).not.toMatch(/private|Users|posthog-server|tidy-public|\.codex/);
    for (const event of c.events())
      expect(event.properties.$exception_list[0].stacktrace.frames).toEqual([]);
  } finally {
    c.transport.mockRestore();
  }
});

test("reviewed server runtime messages retain diagnosis without customer expressions", async () => {
  const c = collector();
  try {
    const failure = new TypeError("Cannot read properties of undefined (reading 'private-token')");
    failure.stack =
      "TypeError: private-token\n    at privateFunction (/private/server/chunk.js:12:3)";
    await createErrorReporter(runtime)(failure, { source: "next", event: "server_request_failed" });
    const exception = c.events()[0].properties.$exception_list[0];
    expect(exception.value).toBe(
      "server_request_failed: Cannot read a property of null or undefined",
    );
    expect(exception.stacktrace.frames[0]).toMatchObject({
      filename: "chunk.js",
      lineno: 12,
      colno: 3,
    });
    expect(c.bodies.join("")).not.toContain("private");
  } finally {
    c.transport.mockRestore();
  }
});

test("server export admission fails closed before contacting PostHog", async () => {
  const c = collector();
  try {
    for (const admit of [
      async () => false,
      async () => {
        throw new Error("budget unavailable");
      },
    ]) {
      await createErrorReporter({ ...runtime, admit })(new Error("sensitive"), {
        source: "worker",
        event: "request_failed",
        route: "/files/private-id",
      });
    }
    expect(c.bodies).toHaveLength(0);
  } finally {
    c.transport.mockRestore();
  }
});
