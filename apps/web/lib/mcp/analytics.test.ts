import { expect, mock, spyOn, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { requestSignal, runWithRequestSignal } from "@/lib/request-lifecycle";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
mock.module("server-only", () => ({}));
const { instrumentMcpAnalytics, sendMcpMetric } = await import("./analytics");
const runtime = {
  enabled: "1",
  key: "fixture-key",
  host: "https://posthog.invalid",
  release: "test-build",
};

function fixture(allowed = true) {
  let callback: (...args: unknown[]) => Promise<unknown>;
  const server = {
    registerTool: (_name: string, _config: unknown, handler: typeof callback) => {
      callback = handler;
    },
  };
  let consent: string | undefined = allowed ? "decision-a" : undefined;
  const sent: unknown[] = [];
  const backend = {
    consent: mock(async () => consent),
    prepareUnlinked: mock(async (timestamp: Date) => {
      void timestamp;
    }),
    withConsent: async (_user: string, id: string, send: () => Promise<void>) => {
      if (id === consent) await send();
    },
    send: mock(async (...args: unknown[]) => {
      sent.push(args);
    }),
  };
  const call = (...args: unknown[]) => callback!(...args);
  return {
    server: server as unknown as McpServer,
    backend,
    call,
    sent,
    change: (next?: string) => {
      consent = next;
    },
  };
}

test("opted-in calls carry only their consent identifier; arguments and results remain untouched", async () => {
  const f = fixture();
  instrumentMcpAnalytics(f.server, "account", runtime, f.backend);
  const input = { prompt: "PRIVATE PROMPT", token: "PRIVATE TOKEN" };
  const result = { content: [{ type: "text" as const, text: "PRIVATE RESULT" }] };
  f.server.registerTool("get_file", { inputSchema: {} }, async (args) => {
    expect(args as unknown).toBe(input);
    return result;
  });
  expect(await f.call(input)).toBe(result);
  expect(f.sent).toHaveLength(1);
  expect(JSON.stringify(f.sent)).not.toMatch(/PRIVATE|account/);
  expect(f.backend.send.mock.calls[0][1]).toMatchObject({ tool: "get_file", failed: false });
});

test("global switch disables monitoring; rejection or unavailable consent emits unlinked metrics", async () => {
  for (const mode of ["off", "rejected", "unavailable"]) {
    const f = fixture(mode !== "rejected");
    if (mode === "unavailable") f.backend.consent.mockRejectedValue(new Error("database failure"));
    instrumentMcpAnalytics(
      f.server,
      "account",
      { ...runtime, enabled: mode === "off" ? "0" : "1" },
      f.backend,
    );
    f.server.registerTool("get_file", {}, async () => ({ content: [] }));
    expect(await f.call()).toEqual({ content: [] });
    expect(f.sent).toHaveLength(mode === "off" ? 0 : 1);
    if (mode === "off") expect(f.backend.consent).not.toHaveBeenCalled();
    else {
      expect(f.backend.send.mock.calls[0][0]).toBeUndefined();
      expect(f.backend.prepareUnlinked).toHaveBeenCalledTimes(1);
    }
  }
});

test("withdrawal or re-opt-in during execution cannot authorise a previous call", async () => {
  for (const next of [undefined, "decision-b"]) {
    const f = fixture();
    instrumentMcpAnalytics(f.server, "account", runtime, f.backend);
    f.server.registerTool("get_file", {}, async () => {
      f.change(next);
      return { content: [] };
    });
    await f.call();
    expect(f.sent).toHaveLength(1);
    expect(f.backend.send.mock.calls[0][0]).toBeUndefined();
  }
});

test("tool errors keep their original behaviour and telemetry failure is isolated", async () => {
  const f = fixture();
  instrumentMcpAnalytics(f.server, "account", runtime, f.backend);
  const error = new Error("SECRET failure");
  f.server.registerTool("get_file", {}, async () => {
    throw error;
  });
  await expect(f.call()).rejects.toBe(error);
  expect(f.backend.send.mock.calls[0][1]).toMatchObject({ failed: true });
  expect(JSON.stringify(f.sent)).not.toContain("SECRET");
  f.backend.send.mockRejectedValue(new Error("transport unavailable"));
  f.server.registerTool("get_file", {}, async () => ({ content: [], isError: true }));
  expect(await f.call()).toEqual({ content: [], isError: true });
});

test("Worker delivery uses waitUntil and rechecks consent before sending", async () => {
  const f = fixture();
  const tasks: Promise<void>[] = [];
  instrumentMcpAnalytics(
    f.server,
    "account",
    {
      ...runtime,
      waitUntil: (task) => {
        tasks.push(task);
      },
    },
    f.backend,
  );
  f.server.registerTool("get_file", {}, async () => ({ content: [] }));
  await f.call();
  expect(tasks).toHaveLength(1);
  await tasks[0];
  expect(f.sent).toHaveLength(1);
});

test("client cancellation does not release the background consent lock", async () => {
  const f = fixture();
  const controller = new AbortController();
  const tasks: Promise<void>[] = [];
  f.backend.withConsent = async (_user, _id, send) => {
    expect(controller.signal.aborted).toBe(true);
    expect(requestSignal()).toBeDefined();
    expect(requestSignal()).not.toBe(controller.signal);
    expect(requestSignal()?.aborted).toBe(false);
    await send();
  };
  instrumentMcpAnalytics(
    f.server,
    "account",
    {
      ...runtime,
      waitUntil: (task) => {
        tasks.push(task);
      },
    },
    f.backend,
  );
  f.server.registerTool("get_file", {}, async () => {
    controller.abort();
    return { content: [] };
  });
  await runWithRequestSignal(controller.signal, () => f.call());
  await Promise.all(tasks);
  expect(f.sent).toHaveLength(1);
});

test("a stalled consent lookup is canceled and monitoring continues without account linking", async () => {
  const f = fixture();
  let lookupSignal: AbortSignal | undefined;
  f.backend.consent.mockImplementation(() => {
    lookupSignal = requestSignal();
    return new Promise(() => {});
  });
  instrumentMcpAnalytics(f.server, "account", runtime, f.backend);
  f.server.registerTool("get_file", {}, async () => ({ content: [] }));
  expect(await f.call()).toEqual({ content: [] });
  expect(lookupSignal?.aborted).toBe(true);
  expect(f.sent).toHaveLength(1);
  expect(f.backend.send.mock.calls[0][0]).toBeUndefined();
});

test("Worker tool response does not wait for slow delivery", async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tasks: Promise<void>[] = [];
  f.backend.send.mockImplementation(async () => {
    await blocked;
  });
  instrumentMcpAnalytics(
    f.server,
    "account",
    {
      ...runtime,
      waitUntil: (task) => {
        tasks.push(task);
      },
    },
    f.backend,
  );
  f.server.registerTool("get_file", {}, async () => ({ content: [] }));
  try {
    expect(await f.call()).toEqual({ content: [] });
    expect(tasks).toHaveLength(1);
  } finally {
    release();
    await Promise.all(tasks);
  }
});

test("a failed background scheduler cannot replace the tool result", async () => {
  const f = fixture();
  instrumentMcpAnalytics(
    f.server,
    "account",
    {
      ...runtime,
      waitUntil: () => {
        throw new Error("scheduler unavailable");
      },
    },
    f.backend,
  );
  f.server.registerTool("get_file", {}, async () => ({ content: [] }));
  expect(await f.call()).toEqual({ content: [] });
});

test.each([false, true])(
  "SDK outbound payload is metadata-only (failed=%s), without exception fan-out",
  async (failed) => {
    const bodies: string[] = [];
    const transport = spyOn(globalThis, "fetch").mockImplementation((async (
      _url: unknown,
      init?: RequestInit,
    ) => {
      bodies.push(
        init?.body instanceof Uint8Array ? gunzipSync(init.body).toString() : String(init?.body),
      );
      return Response.json({ status: 1 });
    }) as typeof fetch);
    try {
      await sendMcpMetric(
        "decision-a",
        {
          tool: "get_file",
          timestamp: new Date(),
          durationMs: 42,
          failed,
          client: { name: "claude-code", version: "2.1.0" },
        },
        runtime,
      );
      const events = bodies.flatMap((body) => {
        const parsed = JSON.parse(body);
        return parsed.batch ?? [parsed];
      });
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("$mcp_tool_call");
      expect(events[0].distinct_id).toBe("mcp:decision-a");
      expect(events[0].properties).toMatchObject({
        $mcp_account_linked: true,
        $mcp_tool_name: "get_file",
        $mcp_duration_ms: 42,
        $mcp_is_error: failed,
        $mcp_client_name: "claude_code",
        $mcp_client_version: "2.1.0",
        $process_person_profile: false,
        $geoip_disable: true,
      });
      expect(JSON.stringify(events)).not.toMatch(
        /\$mcp_parameters|\$mcp_response|\$session_id|\$mcp_intent|\$mcp_llm_model|\$set|\$exception|email|conversation/,
      );
    } finally {
      transport.mockRestore();
    }
  },
);

test("failed consent admission falls back without double-counting an attempted send", async () => {
  for (const deliveryStarted of [false, true]) {
    const f = fixture();
    f.backend.withConsent = async (_user, _id, send) => {
      if (deliveryStarted) await send();
      throw new Error("database commit unavailable");
    };
    instrumentMcpAnalytics(f.server, "account", runtime, f.backend);
    f.server.registerTool("get_file", {}, async () => ({ content: [] }));
    await f.call();
    expect(f.sent).toHaveLength(1);
    expect(f.backend.send.mock.calls[0][0]).toBe(deliveryStarted ? "decision-a" : undefined);
  }
});

test("retention scheduling failure cannot leak untracked events or fail a tool", async () => {
  const f = fixture(false);
  f.backend.prepareUnlinked.mockRejectedValue(new Error("database unavailable"));
  instrumentMcpAnalytics(f.server, "account", runtime, f.backend);
  f.server.registerTool("get_file", {}, async () => ({ content: [] }));
  expect(await f.call()).toEqual({ content: [] });
  expect(f.sent).toHaveLength(0);
});

test("unlinked wire events share only a daily service ID and minute timestamps", async () => {
  const events: { distinct_id: string; timestamp: string; properties: Record<string, unknown> }[] =
    [];
  const transport = spyOn(globalThis, "fetch").mockImplementation((async (
    _url: unknown,
    init?: RequestInit,
  ) => {
    const body =
      init?.body instanceof Uint8Array ? gunzipSync(init.body).toString() : String(init?.body);
    events.push(...JSON.parse(body).batch);
    return Response.json({ status: 1 });
  }) as typeof fetch);
  try {
    for (const timestamp of ["2026-10-16T12:34:56.789Z", "2026-10-16T12:34:59.123Z"]) {
      await sendMcpMetric(
        undefined,
        { tool: "get_file", timestamp: new Date(timestamp), durationMs: 42, failed: false },
        runtime,
      );
    }
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.distinct_id).toBe("mcp:service:2026-10-16");
      expect(new Date(event.timestamp).toISOString()).toBe("2026-10-16T12:34:00.000Z");
      expect(event.properties.$mcp_account_linked).toBe(false);
      expect(Object.keys(event.properties).sort()).toEqual(
        [
          "$mcp_account_linked",
          "$mcp_source",
          "$mcp_server_name",
          "$mcp_method",
          "$mcp_tool_name",
          "$mcp_resource_name",
          "$mcp_duration_ms",
          "$mcp_is_error",
          "$mcp_client_name",
          "$process_person_profile",
          "$geoip_disable",
          "$app_version",
          "$is_server",
          "$lib",
          "$lib_version",
        ].sort(),
      );
    }
  } finally {
    transport.mockRestore();
  }
});

test.each([false, true])(
  "real HTTP tool calls isolate reported clients (account linked=%s)",
  async (linked) => {
    const f = fixture(linked);
    const handler = createMcpHandler(() => {
      const server = instrumentMcpAnalytics(
        new McpServer({ name: "test", version: "1" }),
        "account",
        runtime,
        f.backend,
      );
      server.registerTool(
        "get_file",
        { inputSchema: z.object({ fail: z.boolean().optional(), mcpReq: z.unknown().optional() }) },
        async ({ fail }) => ({ content: [], isError: Boolean(fail) }),
      );
      server.registerTool("no_input", {}, async () => ({ content: [] }));
      return server;
    });
    async function request(method: string, params: object, modern = true) {
      const response = await handler.fetch(
        new Request("https://tidy.test/api/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": modern ? "2026-07-28" : "2025-11-25",
            ...(modern
              ? { "Mcp-Method": method, "Mcp-Name": (params as { name: string }).name }
              : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
      );
      const body = await response.text();
      expect(response.status, body).toBe(200);
      const json = response.headers.get("Content-Type")?.includes("text/event-stream")
        ? body
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6)
        : body;
      const result = JSON.parse(json);
      expect(result.error).toBeUndefined();
      return result;
    }
    try {
      const clients = [
        { name: "codex-mcp-client", version: "0.160.0" },
        { name: "opencode", version: "1.2.3" },
        { name: "PRIVATE CLIENT", version: "PRIVATE VERSION" },
        undefined,
      ];
      const responses = await Promise.all(
        clients.map((client, index) =>
          request("tools/call", {
            name: index === 1 ? "no_input" : "get_file",
            arguments: {
              fail: index === 2,
              mcpReq: {
                envelope: {
                  "io.modelcontextprotocol/clientInfo": { name: "pi", version: "9.9.9" },
                },
              },
            },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              ...(client ? { "io.modelcontextprotocol/clientInfo": client } : {}),
            },
          }),
        ),
      );
      expect(responses[2].result.isError).toBe(true);
      expect(f.sent).toHaveLength(4);
      const metrics = f.backend.send.mock.calls.map(
        (call) => call[1] as { client: { name: string; version?: string }; failed: boolean },
      );
      expect(
        metrics.map((metric) => metric.client).sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        { name: "codex", version: "0.160.0" },
        { name: "opencode", version: "1.2.3" },
        { name: "other" },
        { name: "unknown" },
      ]);
      expect(metrics.find((metric) => metric.client.name === "other")?.failed).toBe(true);
      expect(JSON.stringify(f.sent)).not.toMatch(/PRIVATE|9\.9\.9/);
      for (const call of f.backend.send.mock.calls)
        expect(call[0]).toBe(linked ? "decision-a" : undefined);

      // Production's stateless legacy fallback cannot carry initialize metadata
      // into a later request. It must remain usable, with honest unknown attribution.
      await request(
        "initialize",
        {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codex", version: "0.160.0" },
        },
        false,
      );
      expect(f.sent).toHaveLength(4);
      await request("tools/call", { name: "get_file", arguments: {} }, false);
      expect(f.backend.send.mock.calls[4][1]).toMatchObject({
        client: { name: "unknown" },
        failed: false,
      });
    } finally {
      await handler.close();
    }
  },
);
