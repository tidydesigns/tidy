import { expect, mock, spyOn, test } from "bun:test";
import posthog from "./posthog-client";
import { posthogCollectionEnabled } from "./posthog-policy";
import { createErrorReporter } from "./posthog-server";
import { createRequestTrace } from "./request-tracing";
import { startOperation } from "./trace-context";

mock.module("server-only", () => ({}));
const { vaultEnabled } = await import("./vault/feature-flag");

test("the pause prevents all browser and server delivery even with configured credentials", async () => {
  const transport = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: 1 }));
  const headers = { get: mock(() => null) };
  const waitUntil = mock(() => {});
  const runtime = { key: "test-key", host: "https://posthog.invalid", enabled: "1", waitUntil };
  try {
    expect(posthogCollectionEnabled()).toBe(false);
    posthog.identify("test-person", { email: "test@example.invalid" });
    expect(posthog.capture("test-event")).toBeUndefined();
    expect(posthog.captureException(new Error("test error"))).toBeUndefined();
    posthog.reset();
    await createErrorReporter(headers, runtime)(new Error("test error"), {
      source: "worker",
      event: "request_failed",
    });
    expect(headers.get).not.toHaveBeenCalled();
    expect(await vaultEnabled("test-person", runtime)).toBe(false);

    const trace = createRequestTrace(new Request("https://app.test/api/mcp"), runtime);
    const operation = trace.run(() => startOperation("database.query"));
    expect(trace.operations()).toEqual(["database.query"]);
    expect(trace.traceId()).toBeUndefined();
    trace.snapshot();
    operation.end();
    expect(trace.operations()).toEqual([]);
    trace.finish("request_failed", 500, new Error("test error"));
    expect(waitUntil).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
  }
});

test("source-map uploads stay off even when the old release flag is enabled", () => {
  // Isolate environment changes and config module caching from other tests.
  const result = Bun.spawnSync([process.execPath, "--eval", 'await import("./next.config.ts")'], {
    cwd: import.meta.dir + "/..",
    env: {
      ...process.env,
      POSTHOG_UPLOAD_SOURCEMAPS: "1",
      POSTHOG_API_KEY: "",
      POSTHOG_PROJECT_ID: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: "",
  });
});
