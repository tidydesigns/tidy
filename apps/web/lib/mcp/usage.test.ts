import { expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";

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
