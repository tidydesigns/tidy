import { describe, expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { designNodeSchema } from "@bella/design/document";
import { registerDesignTools, buttonExample } from "./design-tools";
import { componentTreeSchema, composeComponent } from "@/lib/design/compose-component";
import { syncComponentEdit } from "@/lib/design/component-sync";

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
  const document = composeComponent(componentTreeSchema.parse(buttonExample)).document;
  const backend = {
    getDocument: mock(async () => ({ revision: 4, content: document })),
    getExportAssets: mock(async () => []),
  };
  registerDesignTools(server as unknown as McpServer, "authenticated-user", backend);
  const call = async (name: string, args: unknown = {}) => {
    const tool = tools.get(name)!;
    return tool.run(tool.config.inputSchema ? tool.config.inputSchema.parse(args) : args);
  };
  return { call, backend, document };
}

describe("layout-first MCP authoring", () => {
  test("guidance includes serializable recursive schemas and a working semantic button", async () => {
    const { call } = setup();
    const response = await call("get_design_guidance");
    const data = JSON.parse(JSON.stringify(response.structuredContent));
    expect(data.componentSchema).toBeDefined();
    expect(
      data.workflow.some(
        (step: string) => step.includes("inspiration file") && step.includes("get_file_image"),
      ),
    ).toBe(true);
    expect(data.nodeSchema.properties.semantics).toBeDefined();
    expect((await call("compose_component", { tree: data.buttonExample })).isError).toBeUndefined();
  });
  test("creates flow content without guessed text coordinates", async () => {
    const { call } = setup();
    const response = await call("compose_component", { tree: buttonExample });
    const data = response.structuredContent as ReturnType<typeof composeComponent>;
    expect(data.document.nodes[0]).toMatchObject({
      layout: "flex-row",
      align: "center",
      justify: "center",
      isComponent: true,
    });
    expect(data.document.nodes[1]).toMatchObject({
      parentId: "new-thread",
      widthMode: "hug",
      heightMode: "hug",
    });
    expect(data.valid).toBe(true);
  });
  test("refuses unlabeled, unaligned and absolute-positioned controls", async () => {
    const { call } = setup();
    expect(
      (await call("compose_component", { tree: { ...buttonExample, align: undefined } })).isError,
    ).toBe(true);
    expect(
      (await call("compose_component", { tree: { ...buttonExample, children: [] } })).isError,
    ).toBe(true);
    expect(
      (
        await call("compose_component", {
          tree: {
            ...buttonExample,
            layout: "absolute",
            box: { x: 0, y: 0, width: 180, height: 44 },
            children: [
              { ...buttonExample.children[0], box: { x: 20, y: 10, width: 100, height: 24 } },
            ],
          },
        })
      ).isError,
    ).toBe(true);
  });
  test("instances retain geometry and receive master edits without overwriting explicit state overrides", async () => {
    const { call, document } = setup();
    const response = await call("instantiate_component", {
      document,
      component_id: "new-thread",
      instance_id: "second",
      changes: { style: { fill: "#345678" } },
      child_overrides: { label: { text: "Start a longer thread" } },
    });
    expect(response.isError).toBeUndefined();
    const updated = (response.structuredContent as { document: typeof document }).document;
    const synced = syncComponentEdit(updated.nodes, "new-thread", {
      gap: 12,
      style: { fill: "#ffffff" },
    });
    expect(synced.find((node) => node.id === "second")).toMatchObject({
      gap: 12,
      layout: "flex-row",
      style: { fill: "#345678" },
    });
    expect(synced.find((node) => node.id === "second/1")).toMatchObject({
      text: "Start a longer thread",
      componentSourceId: "label",
      widthMode: "hug",
    });
  });
  test("MCP selects named variants and rejects unknown names", async () => {
    const { call, document } = setup();
    const response = await call("instantiate_component", {
      document,
      component_id: "new-thread",
      instance_id: "secondary-button",
      variant: "secondary",
    });
    expect(response.isError).toBeUndefined();
    const updated = (response.structuredContent as { document: typeof document }).document;
    expect(updated.nodes).toHaveLength(4);
    expect(updated.nodes.find((node) => node.id === "secondary-button")).toMatchObject({
      variant: "secondary",
      componentSourceId: "new-thread",
    });
    expect(updated.nodes.filter((node) => node.variants)).toHaveLength(1);
    expect(
      (
        await call("instantiate_component", {
          document,
          component_id: "new-thread",
          instance_id: "bad",
          variant: "unknown",
        })
      ).isError,
    ).toBe(true);
    const exported = await call("export_component", {
      file_id: "file",
      node_id: "new-thread",
      component_name: "Button",
    });
    expect(exported.structuredContent).toMatchObject({
      variants: ["primary", "secondary", "danger"],
      defaultVariant: "primary",
    });
  });
  test("export enforces saved-file access and authenticated asset ownership", async () => {
    const { call, backend } = setup();
    const output = await call("export_component", {
      file_id: "file",
      node_id: "new-thread",
      component_name: "NewThread",
      userId: "spoofed",
    });
    expect(output.isError).toBeUndefined();
    expect(backend.getDocument).toHaveBeenCalledWith("authenticated-user", "file");
    expect(backend.getExportAssets).toHaveBeenCalledWith("authenticated-user", []);
    backend.getDocument.mockRejectedValueOnce(new Error("Document not found or access denied."));
    expect(
      (
        await call("export_component", {
          file_id: "other",
          node_id: "new-thread",
          component_name: "NewThread",
        })
      ).isError,
    ).toBe(true);
    expect(backend.getExportAssets).toHaveBeenCalledTimes(1);
  });
  test("semantics reject script URLs and state geometry changes", () => {
    expect(() =>
      designNodeSchema.parse({
        id: "link",
        parentId: null,
        name: "Link",
        type: "container",
        box: { x: 0, y: 0, width: 100, height: 44 },
        semantics: { element: "a", href: "javascript:alert(1)" },
      }),
    ).toThrow();
    expect(() =>
      componentTreeSchema.parse({ ...buttonExample, states: { hover: { paddingLeft: 40 } } }),
    ).toThrow();
  });
});
