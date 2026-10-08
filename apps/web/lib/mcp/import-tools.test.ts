import { describe, expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { blankDesignDocument } from "@bella/design/document";
import { registerImportTools } from "./import-tools";

type Tool = {
  config: { inputSchema?: z.ZodType };
  run: (args: unknown) => Promise<{ isError?: boolean; structuredContent?: unknown }>;
};
function setup() {
  const tools = new Map<string, Tool>();
  const server = {
    registerTool(name: string, config: Tool["config"], run: Tool["run"]) {
      tools.set(name, { config, run });
    },
  };
  const importer = mock(async () => ({
    fileId: "result",
    url: "/file/result",
    revision: 1,
    nodeCount: 1,
    warnings: [],
  }));
  registerImportTools(server as unknown as McpServer, "authenticated-user", importer);
  const call = async (name: string, args: unknown = {}) => {
    const tool = tools.get(name)!;
    return tool.run(tool.config.inputSchema ? tool.config.inputSchema.parse(args) : args);
  };
  return { importer, call };
}
function capture() {
  return {
    title: "Hero",
    url: "https://example.com/",
    mode: "element",
    assets: [],
    document: {
      ...blankDesignDocument(),
      nodes: [
        {
          id: "frame",
          parentId: null,
          type: "artboard",
          name: "Hero",
          box: { x: 0, y: 0, width: 1440, height: 900 },
        },
      ],
    },
  };
}

describe("MCP rendered import tools", () => {
  test("guidance returns serializable current schemas", async () => {
    const { call } = setup();
    const response = await call("get_import_guidance");
    const data = JSON.parse(JSON.stringify(response.structuredContent));
    expect(data.nodeSchema.properties.type.enum).toContain("vector");
    expect(data.captureSchema.properties.assets).toBeDefined();
    expect(data.capabilities.serverBrowserCapture).toBe(false);
  });
  test("publishes a standalone browser API without requiring the extension", async () => {
    const { call } = setup();
    const response = await call("get_browser_capture_script");
    const data = response.structuredContent as { script: string; sourceHash: string };
    const context = {};
    new Function("globalThis", data.script)(context);
    expect(context).toHaveProperty("__tidyCapture.version", 1);
    expect(context).toHaveProperty("__tidyCapture.prepare");
    expect(context).toHaveProperty("__tidyCapture.capture");
    expect(data.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });
  test("uses authenticated identity and preserves fallback warnings", async () => {
    const { call, importer } = setup();
    const value = capture();
    value.document.warnings = [
      { nodeId: "frame", message: "Laptop perspective flattened; visually unverified." },
    ];
    const response = await call("import_web_capture", {
      organization_id: "org",
      capture: value,
      userId: "spoofed",
    });
    expect(response.isError).toBeUndefined();
    expect(importer).toHaveBeenCalledWith(
      "authenticated-user",
      expect.objectContaining({
        userId: "authenticated-user",
        organizationId: "org",
        capture: expect.objectContaining({
          document: expect.objectContaining({ warnings: value.document.warnings }),
        }),
      }),
    );
  });
  test("invalid source and missing assets are rejected before importing", async () => {
    const { call, importer } = setup();
    await expect(
      call("import_web_capture", {
        organization_id: "org",
        capture: { ...capture(), url: "https://example.com/?token=secret" },
      }),
    ).rejects.toThrow();
    const value = capture();
    const invalid = {
      ...value,
      document: {
        ...value.document,
        nodes: [
          ...value.document.nodes,
          {
            id: "icon",
            parentId: "frame",
            type: "vector",
            name: "GitHub",
            assetId: "00000000-0000-4000-8000-000000000001",
            box: { x: 0, y: 0, width: 24, height: 24 },
          },
        ],
      },
    };
    await expect(
      call("import_web_capture", { organization_id: "org", capture: invalid }),
    ).rejects.toThrow();
    expect(importer).not.toHaveBeenCalled();
  });
  test("returns service access errors as MCP errors", async () => {
    const { call, importer } = setup();
    importer.mockRejectedValueOnce(new Error("File not found or access denied."));
    expect(
      (await call("import_web_capture", { organization_id: "org", capture: capture() })).isError,
    ).toBe(true);
  });
});
