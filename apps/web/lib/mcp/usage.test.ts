import { expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { resolve } from "node:path";

mock.module("server-only", () => ({}));
const { meterMcpServer } = await import("./usage");

function setup(consume = mock(async () => {})) {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const resources = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const server = {
    registerResource(
      name: string,
      _uri: unknown,
      _config: unknown,
      handler: (...args: unknown[]) => Promise<unknown>,
    ) {
      resources.set(name, handler);
      return { name };
    },
    registerTool(
      name: string,
      _config: unknown,
      handler: (...args: unknown[]) => Promise<unknown>,
    ) {
      handlers.set(name, handler);
      return { name };
    },
  };
  meterMcpServer(server as unknown as McpServer, "user", consume);
  return { server, handlers, resources, consume };
}

test("metering reserves once before execution and preserves SDK arguments and results", async () => {
  const { server, handlers, consume } = setup();
  const result = { content: [], structuredContent: { fileId: "file" } };
  const callback = mock(async () => {
    expect(consume).toHaveBeenCalledTimes(1);
    return result;
  });
  server.registerTool("import_web_capture", {}, callback);
  const input = { organization_id: "org", capture: {} },
    context = { signal: new AbortController().signal };
  expect(await handlers.get("import_web_capture")!(input, context)).toBe(result);
  expect(consume).toHaveBeenCalledWith("user", input);
  expect(callback).toHaveBeenCalledWith(input, context);
});

test("exhausted quotas return a readable MCP error without executing the tool", async () => {
  const message = "Free allows 5000 MCP calls per month. Upgrade to Pro for more calls.";
  const consume = mock(async () => {
    throw { code: "P0001", message, detail: JSON.stringify({ code: "PLAN_LIMIT" }) };
  });
  const { server, handlers } = setup(consume);
  const callback = mock(async () => ({}));
  server.registerTool("patch_document", {}, callback);
  expect(await handlers.get("patch_document")!({ file_id: "file" })).toEqual({
    content: [{ type: "text", text: message }],
    isError: true,
  });
  expect(callback).not.toHaveBeenCalled();
});

test("usage failures block execution without exposing database internals", async () => {
  const { server, handlers } = setup(
    mock(async () => {
      throw new Error("private database detail");
    }),
  );
  const callback = mock(async () => ({}));
  server.registerTool("get_file", {}, callback);
  const result = await handlers.get("get_file")!({ file_id: "file" });
  expect(result).toEqual({
    content: [{ type: "text", text: "Could not verify MCP usage. Try again." }],
    isError: true,
  });
  expect(callback).not.toHaveBeenCalled();
});

test("guidance calls are metered and failed operations retain their reserved call", async () => {
  const { server, handlers, consume } = setup();
  const context = { signal: new AbortController().signal };
  const failure = new Error("operation failed");
  const callback = mock(async () => {
    throw failure;
  });
  server.registerTool("get_design_guidance", {}, callback);
  await expect(handlers.get("get_design_guidance")!(context)).rejects.toBe(failure);
  expect(consume).toHaveBeenCalledTimes(1);
  expect(callback).toHaveBeenCalledWith(context);
});

test("file resource reads reserve a call for their template target and preserve SDK context", async () => {
  const { server, resources, consume } = setup();
  const output = { contents: [{ uri: "bella://files/file", text: "{}" }] };
  const callback = mock(async () => output);
  server.registerResource("design-file", {}, {}, callback);
  const uri = new URL("bella://files/file"),
    input = { file_id: "file" },
    context = { requestId: 42 };
  expect(await resources.get("design-file")!(uri, input, context)).toBe(output);
  expect(consume).toHaveBeenCalledWith("user", input);
  expect(callback).toHaveBeenCalledWith(uri, input, context);
});

test("resource reads cannot bypass an exhausted workspace quota", async () => {
  const message = "Pro allows 100000 MCP calls per month.";
  const { server, resources } = setup(
    mock(async () => {
      throw { code: "P0001", message, detail: JSON.stringify({ code: "PLAN_LIMIT" }) };
    }),
  );
  const callback = mock(async () => ({}));
  server.registerResource("design-file", {}, {}, callback);
  await expect(
    resources.get("design-file")!(new URL("bella://files/file"), { file_id: "file" }),
  ).rejects.toThrow(message);
  expect(callback).not.toHaveBeenCalled();
});

test("admission failures report infrastructure errors while expected denials stay quiet", () => {
  // Isolate the reporter mock from the other server telemetry tests.
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
      import { expect, mock } from "bun:test";
      mock.module("server-only", () => ({}));
      const captured = [];
      mock.module("@/lib/posthog-server", () => ({ createErrorReporter: () => async (error, details) => { captured.push({ error, details }); } }));
      const { meterMcpServer } = await import("./lib/mcp/usage.ts");
      const { OperationBudgetError } = await import("./lib/security/operation-budget.ts");
      const { McpGrantError } = await import("./lib/mcp/authorizations.ts");
      let tool, resource, called = false, failure;
      const server = {
        registerTool(_name, _config, callback) { tool = callback; },
        registerResource(_name, _uri, _config, callback) { resource = callback; },
      };
      meterMcpServer(server, "private-user", async () => { throw failure; });
      server.registerTool("create_file", {}, async () => { called = true; });
      server.registerResource("design-file", {}, {}, async () => { called = true; });
      const invoke = () => tool({ organization_id: "private-workspace", name: "private-design" });
      const cause = new DOMException("private guard timeout", "TimeoutError");
      failure = new OperationBudgetError(503, 5, { cause });
      expect(await invoke()).toEqual({ content: [{ type: "text", text: "Temporarily unavailable. Try again shortly." }], isError: true });
      expect(captured).toHaveLength(1);
      expect(captured[0].error).toBe(failure);
      expect(captured[0].error.cause).toBe(cause);
      expect(captured[0].details).toEqual({ source: "operation", event: "operation_failed", operation: "mcp.admission", route: "/api/mcp", method: "POST", phase: "handler" });
      await expect(resource(new URL("bella://files/private-file"), { file_id: "private-file" })).rejects.toThrow("Temporarily unavailable. Try again shortly.");
      expect(captured).toHaveLength(1);
      failure = new OperationBudgetError(429, 60);
      expect((await invoke()).content[0].text).toBe("Too many requests. Try again shortly.");
      failure = new McpGrantError();
      expect((await invoke()).content[0].text).toContain("authorization has ended");
      failure = { code: "42501", message: "private SQL" };
      expect((await invoke()).content[0].text).toContain("access denied");
      failure = { code: "P0001", message: "Monthly quota reached.", detail: JSON.stringify({ code: "PLAN_LIMIT" }) };
      expect((await invoke()).content[0].text).toBe("Monthly quota reached.");
      expect(captured).toHaveLength(1);
      failure = new Error("private database failure");
      expect((await invoke()).content[0].text).toBe("Could not verify MCP usage. Try again.");
      expect(captured.at(-1).error).toBe(failure);
      expect(captured).toHaveLength(2);
      expect(called).toBe(false);
    `,
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
});
