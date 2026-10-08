import { expect, spyOn, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { createRequestTrace } from "./request-tracing";
import { startOperation, traceDetails, traceOperation } from "./trace-context";
import { observeRequest } from "./request-observability";
import { handleRequest } from "./request-boundary";
import { handleAuthRequest } from "./auth/request-boundary";
import { requestDatabaseClient } from "./request-database-client";
import { runWithRequestSignal } from "./request-lifecycle";
import { tracedDatabaseClient } from "./traced-database-client";
import type { PoolClient } from "pg";

type ExportSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: {
    key: string;
    value: { stringValue?: string; boolValue?: boolean; intValue?: string };
  }[];
  status?: { code: number };
  events?: unknown[];
};
function collector() {
  const payloads: string[] = [];
  const tasks: Promise<unknown>[] = [];
  const transport = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const bytes = new Uint8Array(await new Request(input, init).arrayBuffer());
    payloads.push(
      (bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes) : Buffer.from(bytes)).toString(),
    );
    return new Response('{"status":1}', { status: 200 });
  }) as typeof fetch);
  const runtime = {
    key: "test-key",
    host: "https://posthog.invalid",
    release: "test-release",
    deploymentId: "test-deployment",
    waitUntil: (task: Promise<unknown>) => {
      tasks.push(task);
    },
  };
  return {
    payloads,
    tasks,
    transport,
    runtime,
    async spans() {
      await Promise.all(tasks);
      return payloads.flatMap((body) =>
        JSON.parse(body).resourceSpans.flatMap(
          (resource: { scopeSpans: { spans: ExportSpan[] }[] }) =>
            resource.scopeSpans.flatMap((scope) => scope.spans),
        ),
      ) as ExportSpan[];
    },
  };
}
function attr(span: ExportSpan, key: string) {
  return span.attributes.find((item) => item.key === key)?.value;
}

test("edge SDK spans stay nested across await and concurrent requests without recording private input", async () => {
  const c = collector();
  try {
    const a = createRequestTrace(
      new Request("https://app.test/api/files/private-id/changes?token=secret", {
        headers: { "cf-ray": "ray-a", authorization: "private-bearer", cookie: "private-cookie" },
      }),
      c.runtime,
    );
    const b = createRequestTrace(
      new Request("https://app.test/api/mcp", { headers: { "cf-ray": "ray-b" } }),
      c.runtime,
    );
    await Promise.all([
      a.run(() =>
        traceOperation("auth.api", async () => {
          await Promise.resolve();
          await traceOperation("database.connect", async () => {
            await Promise.resolve();
          });
        }),
      ),
      b.run(() =>
        traceOperation("oauth.client_metadata", async () => {
          await Promise.resolve();
        }),
      ),
    ]);
    a.finish("request_completed", 200);
    b.finish("request_completed", 401);
    const spans = await c.spans();
    const auth = spans.find((s) => s.name === "auth.api")!;
    const db = spans.find((s) => s.name === "database.connect")!;
    const roots = spans.filter((s) => !s.parentSpanId || /^0+$/.test(s.parentSpanId));
    expect(roots).toHaveLength(2);
    expect(db.parentSpanId).toBe(auth.spanId);
    expect(db.traceId).toBe(auth.traceId);
    expect(spans.find((s) => s.name === "oauth.client_metadata")!.traceId).not.toBe(auth.traceId);
    expect(roots.map((s) => s.name)).toContain("GET /api/files/:id/changes");
    expect(c.payloads.join("\n")).toContain("test-deployment");
    expect(c.payloads.join("\n")).toContain("test-release");
    expect(c.payloads.join("\n")).not.toMatch(/private-id|secret|private-bearer|private-cookie/);
  } finally {
    c.transport.mockRestore();
  }
});

test("stalled spans export a snapshot before work settles and retain the eventual outcome", async () => {
  const c = collector();
  let release!: () => void;
  try {
    const trace = createRequestTrace(new Request("https://app.test/files"), c.runtime);
    const pending = trace.run(() =>
      traceOperation("auth.api", () =>
        traceOperation(
          "database.connect",
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        ),
      ),
    );
    trace.snapshot();
    trace.snapshot();
    const snapshots = await c.spans();
    expect(snapshots).toHaveLength(3);
    expect(snapshots.every((s) => attr(s, "app.snapshot")?.boolValue)).toBe(true);
    expect(snapshots.find((s) => s.name === "database.connect")!.parentSpanId).toBe(
      snapshots.find((s) => s.name === "auth.api")!.spanId,
    );
    release();
    await pending;
    trace.finish("request_completed", 200);
    const all = await c.spans();
    expect(all).toHaveLength(6);
    const final = all.find((s) => s.name === "GET /files" && !attr(s, "app.snapshot"))!;
    expect(attr(final, "app.request_outcome")?.stringValue).toBe("request_completed");
    expect(
      attr(
        snapshots.find((s) => s.name === "GET /files")!,
        "app.request_trace_id",
      )?.stringValue,
    ).toBe(final.traceId);
  } finally {
    release?.();
    c.transport.mockRestore();
  }
});

test("work inside a completed connection callback attaches to the active caller", async () => {
  const c = collector();
  try {
    const trace = createRequestTrace(new Request("https://app.test/files"), c.runtime);
    await trace.run(() =>
      traceOperation("auth.api", async () => {
        const connection = startOperation("database.connect");
        await connection.run(async () => {
          await Promise.resolve();
          connection.end();
          await traceOperation("database.query", async () => {});
        });
      }),
    );
    trace.finish("request_completed", 200);
    const spans = await c.spans();
    expect(spans.find((s) => s.name === "database.query")!.parentSpanId).toBe(
      spans.find((s) => s.name === "auth.api")!.spanId,
    );
  } finally {
    c.transport.mockRestore();
  }
});

test("request fan-out is bounded and reports the dropped span count", async () => {
  const c = collector();
  try {
    const trace = createRequestTrace(new Request("https://app.test/files"), c.runtime);
    trace.run(() => {
      for (let index = 0; index < 300; index++) startOperation("database.query");
    });
    expect(trace.operations()).toEqual(["database.query"]);
    trace.finish("request_aborted");
    const spans = await c.spans();
    expect(spans).toHaveLength(257);
    expect(
      attr(
        spans.find((s) => s.name === "GET /files")!,
        "app.dropped_spans",
      )?.intValue,
    ).toBe("44");
  } finally {
    c.transport.mockRestore();
  }
});

test("failure codes reach spans while the original application error stays unchanged", async () => {
  const c = collector();
  const error = Object.assign(new Error("private SQL and token=secret"), { code: "ECONNRESET" });
  try {
    const trace = createRequestTrace(new Request("https://app.test/api/mcp"), c.runtime);
    await expect(
      trace.run(() =>
        traceOperation("database.query", async () => {
          throw error;
        }),
      ),
    ).rejects.toBe(error);
    trace.finish("request_failed", 500, error);
    const spans = await c.spans();
    expect(spans.every((s) => attr(s, "error.code")?.stringValue === "ECONNRESET")).toBe(true);
    expect(spans.every((s) => s.status?.code === 2)).toBe(true);
    expect(c.payloads.join("\n")).not.toMatch(/private SQL|token=secret/);
  } finally {
    c.transport.mockRestore();
  }
});

test("trace completion marks still pending operations and does not duplicate later endings", async () => {
  const c = collector();
  try {
    const trace = createRequestTrace(new Request("https://app.test/files"), c.runtime);
    const operation = trace.run(() => startOperation("auth.api"));
    trace.finish("request_aborted");
    const spans = await c.spans();
    expect(
      attr(
        spans.find((s) => s.name === "auth.api")!,
        "app.unfinished",
      )?.boolValue,
    ).toBe(true);
    operation.end();
    trace.finish("request_aborted");
    expect(await c.spans()).toHaveLength(2);
  } finally {
    c.transport.mockRestore();
  }
});

test("HTML body completion is traced without buffering and MCP SSE finishes at response headers", async () => {
  const c = collector();
  try {
    const page = await observeRequest(
      new Request("https://app.test/files"),
      async () =>
        new Response("page", { headers: { "Content-Type": "text/html", "X-Test": "preserved" } }),
      undefined,
      c.runtime,
    );
    expect(c.tasks).toHaveLength(0);
    expect(await page.text()).toBe("page");
    expect(page.headers.get("X-Test")).toBe("preserved");
    expect((await c.spans()).map((s) => s.name)).toContain("response.body");
    const stream = new ReadableStream({ start() {} });
    const original = new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    const sse = await observeRequest(
      new Request("https://app.test/api/mcp"),
      async () => original,
      undefined,
      c.runtime,
    );
    expect(sse).toBe(original);
    expect((await c.spans()).filter((s) => s.name === "GET /api/mcp")).toHaveLength(1);
    await sse.body!.cancel();
  } finally {
    c.transport.mockRestore();
  }
});

test("disabled tracing does no network I/O and captures operation names for diagnostics", async () => {
  const c = collector();
  try {
    const trace = createRequestTrace(new Request("https://app.test/files"), {
      ...c.runtime,
      enabled: "0",
    });
    trace.run(() => {
      const operation = startOperation("auth.api");
      expect(traceDetails().operations).toEqual(["auth.api"]);
      operation.end();
    });
    trace.snapshot();
    trace.finish("request_completed", 200);
    expect(c.transport).not.toHaveBeenCalled();
  } finally {
    c.transport.mockRestore();
  }
});

test("a failed HTML stream marks the root and body spans without changing the error", async () => {
  const c = collector();
  const failure = Object.assign(new Error("private rendering failure"), { code: "ECONNRESET" });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(failure);
      },
    });
    const response = await observeRequest(
      new Request("https://app.test/files"),
      async () => new Response(body, { headers: { "Content-Type": "text/html" } }),
      undefined,
      c.runtime,
    );
    await expect(response.text()).rejects.toBe(failure);
    const spans = await c.spans();
    for (const name of ["GET /files", "response.body"]) {
      const span = spans.find((s) => s.name === name)!;
      expect(span.status?.code).toBe(2);
      expect(attr(span, "error.code")?.stringValue).toBe("ECONNRESET");
    }
    expect(c.payloads.join("\n")).not.toContain("private rendering failure");
  } finally {
    c.transport.mockRestore();
    log.mockRestore();
  }
});

test("broken telemetry exports never change the request result", async () => {
  const c = collector();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  c.transport.mockRejectedValue(new Error("private exporter failure"));
  try {
    const response = await observeRequest(
      new Request("https://app.test/api/health"),
      async () => new Response("ok"),
      undefined,
      c.runtime,
    );
    expect(await response.text()).toBe("ok");
    await Promise.all(c.tasks);
  } finally {
    c.transport.mockRestore();
    warn.mockRestore();
  }
});

test("the request deadline retains the trace ID and exports the actual 503 outcome", async () => {
  const c = collector();
  let reportedTrace: string | undefined;
  try {
    const request = new Request("https://app.test/api/mcp");
    const response = await observeRequest(
      request,
      () =>
        handleRequest(
          request,
          () => traceOperation("auth.api", () => new Promise<Response>(() => {})),
          20,
          async () => {
            reportedTrace = traceDetails().trace_id;
          },
        ),
      undefined,
      c.runtime,
    );
    expect(response.status).toBe(503);
    const spans = await c.spans();
    const root = spans.find((s) => s.name === "GET /api/mcp")!;
    expect(reportedTrace).toBe(root.traceId);
    expect(attr(root, "http.response.status_code")?.intValue).toBe("503");
    expect(root.status?.code).toBe(2);
    expect(
      attr(
        spans.find((s) => s.name === "auth.api")!,
        "app.unfinished",
      )?.boolValue,
    ).toBe(true);
  } finally {
    c.transport.mockRestore();
  }
});

test("database tracing preserves request cancellation and socket destruction", async () => {
  const c = collector();
  const controller = new AbortController();
  const failure = new DOMException("private cancellation", "TimeoutError");
  let destroyed = false;
  try {
    const trace = createRequestTrace(new Request("https://app.test/files"), c.runtime);
    const raw = {
      query: () => new Promise(() => {}),
      release(error: boolean) {
        destroyed = error;
      },
    };
    await trace.run(() =>
      runWithRequestSignal(controller.signal, async () => {
        const client = requestDatabaseClient(tracedDatabaseClient(raw as unknown as PoolClient));
        const query = client.query("private SQL");
        controller.abort(failure);
        await expect(query).rejects.toBe(failure);
        expect(destroyed).toBe(true);
      }),
    );
    trace.finish("request_failed", 503, failure);
    const spans = await c.spans();
    expect(spans.find((s) => s.name === "database.query")!.status?.code).toBe(2);
    expect(c.payloads.join("\n")).not.toMatch(/private SQL|private cancellation/);
  } finally {
    c.transport.mockRestore();
  }
});

test.each(["handler", "body"])(
  "the auth %s deadline keeps its retry response and trace correlation",
  async (phase) => {
    const c = collector();
    let reportedTrace: string | undefined;
    try {
      const request = new Request(
        "https://app.test/api/auth/oauth2/authorize?state=private-state",
        {
          headers: { accept: "text/html" },
        },
      );
      const response = await observeRequest(
        request,
        () =>
          handleAuthRequest(
            request,
            async () => {
              if (phase === "handler")
                return traceOperation("auth.endpoint", () => new Promise<Response>(() => {}));
              return new Response(new ReadableStream(), {
                headers: { "Content-Type": "text/html" },
              });
            },
            20,
            async () => {
              reportedTrace = traceDetails().trace_id;
            },
          ),
        undefined,
        c.runtime,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = await response.text();
      expect(body).toContain("Try again");
      expect(body).not.toContain("private-state");
      const root = (await c.spans()).find(
        (span) => span.name === "GET /api/auth/oauth2/authorize",
      )!;
      expect(reportedTrace).toBe(root.traceId);
      expect(attr(root, "http.response.status_code")?.intValue).toBe("503");
      expect(root.status?.code).toBe(2);
      expect(c.payloads.join("\n")).not.toContain("private-state");
    } finally {
      c.transport.mockRestore();
    }
  },
);
