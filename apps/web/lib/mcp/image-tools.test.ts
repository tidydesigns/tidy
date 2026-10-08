import { expect, mock, test } from "bun:test";
import {
  InMemoryTransport,
  McpServer,
  type CallToolResult,
  type JSONRPCMessage,
  type JSONRPCResultResponse,
} from "@modelcontextprotocol/server";
import { registerImageTools } from "./image-tools";
import { requiredMcpScopes } from "./scopes";
import type { getFileImage } from "@/lib/design/file-image";

const assetId = "00000000-0000-4000-8000-000000000001";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz0AAAAASUVORK5CYII=";

test("MCP wire exposes vision images and explicit terminal bytes with read scope", async () => {
  const image: Awaited<ReturnType<typeof getFileImage>> = {
    fileId: "inspiration",
    assetId,
    revision: 7,
    mimeType: "image/png",
    byteSize: Buffer.from(png, "base64").length,
    base64: png,
    layers: [
      {
        nodeId: "screenshot",
        name: "Hero inspiration",
        type: "image",
        box: { x: 0, y: 0, width: 400, height: 300 },
        imageCrop: undefined,
        paints: undefined,
      },
    ],
  };
  const read = mock(async () => image);
  const server = new McpServer({ name: "image-test", version: "1" });
  registerImageTools(server, "authenticated-user", read);
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (message: JSONRPCMessage) => void>();
  client.onmessage = (message) => {
    if ("id" in message) pending.get(Number(message.id))?.(message);
  };
  let id = 0;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const requestId = ++id;
    const response = new Promise<JSONRPCMessage>((resolve) => pending.set(requestId, resolve));
    await client.send({ jsonrpc: "2.0", id: requestId, method, params });
    const result = await response;
    pending.delete(requestId);
    expect(result).not.toHaveProperty("error");
    return (result as JSONRPCResultResponse).result;
  };
  const call = async (args: Record<string, unknown>) =>
    (await request("tools/call", { name: "get_file_image", arguments: args })) as CallToolResult;
  try {
    await server.connect(transport);
    await client.start();
    await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await request("tools/list");
    expect(list.tools).toEqual([
      expect.objectContaining({
        name: "get_file_image",
        annotations: expect.objectContaining({ readOnlyHint: true }),
      }),
    ]);
    expect(requiredMcpScopes({ method: "tools/call", params: { name: "get_file_image" } })).toEqual(
      ["mcp:read"],
    );
    for (const mimeType of ["image/png", "image/jpeg", "image/webp"]) {
      read.mockResolvedValueOnce({ ...image, mimeType });
      const response = await call({ file_id: "inspiration", asset_id: assetId });
      expect(read).toHaveBeenLastCalledWith("authenticated-user", "inspiration", assetId);
      expect(response.content).toContainEqual({ type: "image", data: png, mimeType });
      expect(response.structuredContent).toMatchObject({
        revision: 7,
        outputFormat: "image",
        layers: [{ name: "Hero inspiration" }],
      });
      expect(response.structuredContent).not.toHaveProperty("base64");
    }
    const bytes = await call({
      file_id: "inspiration",
      asset_id: assetId,
      output_format: "base64",
    });
    expect(bytes.content).toHaveLength(1);
    expect(JSON.parse((bytes.content[0] as { text: string }).text)).toMatchObject({
      base64: png,
      outputFormat: "base64",
    });
    expect(bytes.structuredContent).toMatchObject({ base64: png });
    read.mockResolvedValueOnce({
      ...image,
      mimeType: "image/svg+xml",
      base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64"),
    });
    const svg = await call({ file_id: "inspiration", asset_id: assetId });
    expect(svg.content).toHaveLength(1);
    expect(svg.structuredContent).toMatchObject({
      mimeType: "image/svg+xml",
      outputFormat: "base64",
    });
    read.mockRejectedValueOnce(new Error("File image not found or access denied."));
    const denied = await call({ file_id: "private", asset_id: assetId });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toBeUndefined();
    expect(denied.content).toEqual([
      { type: "text", text: "File image not found or access denied." },
    ]);
    const calls = read.mock.calls.length;
    expect((await call({ file_id: "inspiration", asset_id: "invalid" })).isError).toBe(true);
    expect(
      (await call({ file_id: "inspiration", asset_id: assetId, output_format: "url" })).isError,
    ).toBe(true);
    expect(read.mock.calls).toHaveLength(calls);
  } finally {
    await server.close();
    await client.close();
  }
});
