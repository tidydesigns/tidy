import { expect, test, mock } from "bun:test";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { blankDesignDocument, buildDrawnNode } from "@bella/design/document";
import { registerPluginTools } from "./plugin-tools";

function setup(denied = false) {
  const document = {
    ...blankDesignDocument(),
    nodes: [buildDrawnNode("screen", "artboard", null, { x: 0, y: 0, width: 360, height: 280 })],
  };
  const backend = {
    getDocument: mock(async () => ({ revision: 3, content: document })),
    getExportAssets: mock(async () => [{ id: "image", mimeType: "image/png", base64: "aGVsbG8=" }]),
    getDesignFile: mock(async () =>
      denied
        ? null
        : {
            id: "file",
            name: "Example",
            organizationId: "org",
            organizationName: "Team",
            folderId: null,
            archivedAt: null,
            updatedAt: new Date(),
            role: "owner",
            frames: [],
            rectangles: [],
          },
    ),
  };
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "Tidy plugin test", version: "0.1.0" });
    registerPluginTools(server, "authenticated-user", backend, "https://app.tidydesign.co");
    return server;
  });
  const call = async (method: string, params: object) => {
    const response = await handler.fetch(
      new Request("https://app.tidydesign.co/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-03-26",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    const body = await response.text();
    const json = response.headers.get("Content-Type")?.includes("text/event-stream")
      ? body
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6)
      : body;
    return JSON.parse(json);
  };
  return { call, backend };
}
test("advertises the UI, OAuth policy, exact output schema and a working bundled resource over MCP", async () => {
  const { call } = setup();
  const tools = await call("tools/list", {});
  const tool = tools.result.tools.find((tool: { name: string }) => tool.name === "preview_design");
  expect(tool.annotations).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
  expect(tool._meta.securitySchemes[0]).toEqual({
    type: "oauth2",
    scopes: ["mcp:read", "mcp:write"],
  });
  expect(tool.outputSchema.properties.revision).toBeDefined();
  const resource = await call("resources/read", { uri: tool._meta.ui.resourceUri });
  expect(resource.result.contents[0].mimeType).toBe("text/html;profile=mcp-app");
  expect(resource.result.contents[0].text).toContain("Open in Tidy");
  expect(resource.result.contents[0]._meta.ui.csp.connectDomains).toEqual([]);
});
test("hydrates authorized files and assets privately while the model receives a concise summary", async () => {
  const { call, backend } = setup();
  const response = await call("tools/call", {
    name: "preview_design",
    arguments: { file_id: "file" },
  });
  expect(response.result.structuredContent).toMatchObject({
    fileId: "file",
    revision: 3,
    url: "https://app.tidydesign.co/files/file",
  });
  expect(response.result.structuredContent.document).toBeUndefined();
  expect(response.result._meta.tidyPreview.assets.image).toBe("data:image/png;base64,aGVsbG8=");
  expect(backend.getDocument).toHaveBeenCalledWith("authenticated-user", "file");
  expect(backend.getExportAssets).toHaveBeenCalledWith("authenticated-user", []);
});
test("denied files do not disclose documents or asset bytes", async () => {
  const { call, backend } = setup(true);
  const response = await call("tools/call", {
    name: "preview_design",
    arguments: { file_id: "file" },
  });
  expect(response.result.isError).toBe(true);
  expect(response.result._meta).toBeUndefined();
  expect(backend.getDocument).not.toHaveBeenCalled();
  expect(backend.getExportAssets).not.toHaveBeenCalled();
});
test("a missing selected root is rejected before reading assets", async () => {
  const { call, backend } = setup();
  const response = await call("tools/call", {
    name: "preview_design",
    arguments: { file_id: "file", root_id: "missing" },
  });
  expect(response.result.isError).toBe(true);
  expect(backend.getExportAssets).not.toHaveBeenCalled();
});
