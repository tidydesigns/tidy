import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { request as httpRequest } from "node:http";
import { AgentMcpBridge } from "./mcp-bridge";
import { CloudComputeBusyError } from "../cloud/cloud-compute";
import { TaskStoreError } from "./task-store";

const bridges: AgentMcpBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});
async function setup(authorize: () => Promise<AbortSignal | void> = async () => {}) {
  const bridge = new AgentMcpBridge({
    tools: (scope) => [
      {
        name: "context_read",
        description: "Read scoped context.",
        readOnly: true,
        inputSchema: z.object({}),
        invoke: async () => ({
          projectId: scope.projectId,
          threadId: scope.threadId,
        }),
      },
    ],
  });
  bridges.push(bridge);
  const connection = await bridge.session({
    projectId: "project",
    threadId: "thread",
    designIds: [],
    writable: false,
    authorize,
  });
  return { bridge, connection };
}
function request(
  connection: { url: string; token: string },
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(connection.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
async function payload(response: Response) {
  const text = await response.text();
  if (!text.startsWith("event:") && !text.startsWith("data:") && !text.startsWith(":"))
    return JSON.parse(text);
  const line = text.split("\n").find((value) => value.startsWith("data: "));
  if (!line) throw new Error("Missing MCP response.");
  return JSON.parse(line.slice(6));
}

test("serves real initialize, tool discovery and scoped tool calls", async () => {
  const { connection } = await setup();
  const initialized = await request(connection, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  expect(initialized.status).toBe(200);
  expect(await payload(initialized)).toMatchObject({
    result: { serverInfo: { name: "tidy" } },
  });
  const list = await payload(
    await request(connection, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  );
  expect(list.result.tools).toHaveLength(1);
  const called = await payload(
    await request(connection, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "context_read", arguments: {} },
    }),
  );
  expect(called.result.structuredContent).toEqual({
    projectId: "project",
    threadId: "thread",
  });
});

test("rejects browser origins, forged hosts, invalid tokens and revoked sessions", async () => {
  const { connection } = await setup();
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  expect((await request(connection, body, { Origin: "https://example.com" })).status).toBe(403);
  expect((await request(connection, body, { Host: "example.com" })).status).toBe(403);
  expect((await request({ ...connection, token: "invalid" }, body)).status).toBe(403);
  connection.close();
  expect((await request(connection, body)).status).toBe(403);
});

test("permits idle static discovery while checking live authority for tool calls", async () => {
  let active = true;
  const { connection } = await setup(async () => {
    if (!active) throw new Error("Thread stopped.");
  });
  expect(
    (
      await request(connection, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      })
    ).status,
  ).toBe(200);
  active = false;
  expect(
    (await request(connection, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).status,
  ).toBe(200);
  expect(
    (
      await request(connection, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "context_read", arguments: {} },
      })
    ).status,
  ).toBe(403);
});

test("bounds request bodies before protocol parsing", async () => {
  const { connection } = await setup();
  expect((await request(connection, { payload: "x".repeat(1024 * 1024) })).status).toBe(413);
});

test("a stopped turn cannot complete an in-flight tool in a later turn", async () => {
  let turn = new AbortController();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let observed: AbortSignal | undefined;
  const bridge = new AgentMcpBridge({
    tools: (scope) => [
      {
        name: "wait",
        description: "Wait.",
        inputSchema: z.object({}),
        invoke: async () => {
          observed = scope.signal;
          entered.resolve();
          await finish.promise;
          return { done: true };
        },
      },
    ],
  });
  bridges.push(bridge);
  const connection = await bridge.session({
    projectId: "project",
    threadId: "thread",
    designIds: [],
    writable: true,
    authorize: async () => turn.signal,
  });
  const pending = request(connection, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "wait", arguments: {} },
  });
  await entered.promise;
  turn.abort();
  turn = new AbortController();
  finish.resolve();
  const response = await pending;
  expect(observed?.aborted).toBe(true);
  expect(response.status).toBe(200);
  expect(await payload(response)).toMatchObject({
    result: { isError: true, structuredContent: { error: { code: "UNAVAILABLE" } } },
  });
});

test("unexpected tool failures never expose host paths or credentials", async () => {
  const bridge = new AgentMcpBridge({
    tools: () => [
      {
        name: "fail",
        description: "Fail.",
        inputSchema: z.object({}),
        invoke: async () => {
          throw new Error("Could not open /home/private/customer.json token=secret");
        },
      },
    ],
  });
  bridges.push(bridge);
  const connection = await bridge.session({
    projectId: "project",
    threadId: "thread",
    designIds: [],
    writable: false,
    authorize: async () => {},
  });
  const result = await payload(
    await request(connection, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "fail", arguments: {} },
    }),
  );
  expect(result.result.isError).toBe(true);
  expect(result.result.structuredContent.error.code).toBe("INTERNAL");
  expect(JSON.stringify(result)).not.toContain("/home/private");
  expect(JSON.stringify(result)).not.toContain("token=secret");
});

test("session authority is copied before the caller can mutate its design list", async () => {
  const bridge = new AgentMcpBridge({
    tools: (scope) => [
      {
        name: "scope",
        description: "Scope.",
        inputSchema: z.object({}),
        invoke: async () => ({ designIds: scope.designIds }),
      },
    ],
  });
  bridges.push(bridge);
  const designIds = ["attached"];
  const connection = await bridge.session({
    projectId: "project",
    threadId: "thread",
    designIds,
    writable: false,
    authorize: async () => {},
  });
  designIds.push("unattached");
  const result = await payload(
    await request(connection, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "scope", arguments: {} },
    }),
  );
  expect(result.result.structuredContent.designIds).toEqual(["attached"]);
});

test("canvas previews use native image content and compact metadata", async () => {
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=";
  const bridge = new AgentMcpBridge({
    tools: () => [
      {
        name: "render",
        description: "Render.",
        inputSchema: z.object({}),
        invoke: async () => ({
          kind: "rendered",
          mime_type: "image/png",
          data,
          width: 1,
          height: 1,
          version: "1",
        }),
      },
    ],
  });
  bridges.push(bridge);
  const connection = await bridge.session({
    projectId: "project",
    threadId: "thread",
    designIds: [],
    writable: false,
    authorize: async () => {},
  });
  const result = await payload(
    await request(connection, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "render", arguments: {} },
    }),
  );
  expect(result.result.content).toContainEqual({ type: "image", mimeType: "image/png", data });
  expect(result.result.content[0].text).not.toContain(data);
  expect(result.result.structuredContent).not.toHaveProperty("data");
  expect(result.result.structuredContent.version).toBe("1");
});

test("oversized structured results return a bounded actionable failure", async () => {
  const bridge = new AgentMcpBridge({
    tools: () => [
      {
        name: "large",
        description: "Large.",
        inputSchema: z.object({}),
        invoke: async () => ({ text: "x".repeat(256 * 1024) }),
      },
    ],
  });
  bridges.push(bridge);
  const connection = await bridge.session({
    projectId: "project",
    threadId: "thread",
    designIds: [],
    writable: false,
    authorize: async () => {},
  });
  const response = await request(connection, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "large", arguments: {} },
  });
  const result = await payload(response);
  expect(result.result.isError).toBe(true);
  expect(result.result.structuredContent.error.code).toBe("BUSY");
  expect(JSON.stringify(result).length).toBeLessThan(2000);
});

test("a tool deadline returns a structured failure before the transport closes", async () => {
  let cancelled: AbortSignal | undefined;
  const bridge = new AgentMcpBridge({
    toolTimeoutMs: 20,
    tools: (scope) => [
      {
        name: "slow_read",
        description: "Slow read",
        inputSchema: z.object({}),
        invoke: async () => {
          cancelled = scope.signal;
          return new Promise(() => {});
        },
      },
    ],
  });
  bridges.push(bridge);
  const connection = await bridge.session({
    projectId: "project",
    threadId: "thread",
    designIds: [],
    writable: false,
    authorize: async () => {},
  });
  const response = await request(connection, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "slow_read", arguments: {} },
  });
  expect(response.status).toBe(200);
  expect(await payload(response)).toMatchObject({
    result: {
      isError: true,
      structuredContent: { error: { code: "UNAVAILABLE", retryable: true } },
    },
  });
  expect(cancelled?.aborted).toBe(true);
});

test("request ID conflicts are actionable nonretryable protocol errors", async () => {
  const bridge = new AgentMcpBridge({
    tools: () => [
      {
        name: "task_write",
        description: "Write assignment",
        inputSchema: z.object({}),
        invoke: async () => {
          throw new TaskStoreError("REQUEST_CONFLICT", "Private storage detail");
        },
      },
    ],
  });
  bridges.push(bridge);
  const connection = await bridge.session({
    projectId: "project",
    threadId: "thread",
    designIds: [],
    writable: true,
    authorize: async () => {},
  });
  const result = await payload(
    await request(connection, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "task_write", arguments: {} },
    }),
  );
  expect(result).toMatchObject({
    result: { isError: true, structuredContent: { error: { code: "CONFLICT", retryable: false } } },
  });
  expect(JSON.stringify(result)).not.toContain("Private storage detail");
});

test("malformed tool outputs fail their advertised schema without leaking implementation details", async () => {
  const bridge = new AgentMcpBridge({
    tools: () => [
      {
        name: "typed_read",
        description: "Typed read",
        inputSchema: z.object({}),
        outputSchema: z.object({ count: z.number() }),
        invoke: async () => ({ count: "wrong", private: "/private/host/detail" }),
      },
    ],
  });
  bridges.push(bridge);
  const connection = await bridge.session({
    projectId: "project",
    threadId: "thread",
    designIds: [],
    writable: false,
    authorize: async () => {},
  });
  const result = await payload(
    await request(connection, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "typed_read", arguments: {} },
    }),
  );
  expect(result).toMatchObject({
    result: { isError: true, structuredContent: { error: { code: "INVALID_INPUT" } } },
  });
  expect(JSON.stringify(result)).not.toContain("/private/host/detail");
});

test("incomplete authenticated bodies time out and release their admission slots", async () => {
  const bridge = new AgentMcpBridge({ requestTimeoutMs: 50, tools: () => [] });
  bridges.push(bridge);
  const connection = await bridge.session({
    projectId: "project",
    threadId: "thread",
    designIds: [],
    writable: false,
    authorize: async () => {},
  });
  await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise<void>((resolve, reject) => {
          const client = httpRequest(connection.url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${connection.token}`,
              "Content-Type": "application/json",
              "Content-Length": 1000,
            },
          });
          const deadline = setTimeout(() => {
            client.destroy();
            reject(new Error("Incomplete request outlived its server deadline."));
          }, 1000);
          client.once("error", () => {
            clearTimeout(deadline);
            resolve();
          });
          client.once("response", (response) => {
            response.resume();
            response.once("end", () => {
              clearTimeout(deadline);
              resolve();
            });
          });
          client.write("{");
        }),
    ),
  );
  expect((await request(connection, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(
    200,
  );
});

test("batch bodies cannot multiply tool invocations inside one admission slot", async () => {
  const { connection } = await setup();
  const response = await request(connection, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "context_read", arguments: {} },
    },
  ]);
  expect(response.status).toBe(400);
});

test("canvas worker saturation is a retryable MCP error", async () => {
  const bridge = new AgentMcpBridge({
    tools: () => [
      {
        name: "canvas_edit",
        description: "Edit canvas",
        inputSchema: z.object({}),
        invoke: async () => {
          throw new CloudComputeBusyError();
        },
      },
    ],
  });
  bridges.push(bridge);
  const connection = await bridge.session({
    projectId: "project",
    threadId: "thread",
    designIds: [],
    writable: true,
    authorize: async () => {},
  });
  const result = await payload(
    await request(connection, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "canvas_edit", arguments: {} },
    }),
  );
  expect(result).toMatchObject({
    result: { isError: true, structuredContent: { error: { code: "BUSY", retryable: true } } },
  });
});
