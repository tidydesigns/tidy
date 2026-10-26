import { expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ZodType } from "zod";
mock.module("server-only", () => ({}));
const { registerContextTools } = await import("./context-tools");
const { blankDesignDocument, designNodeSchema } = await import("@/lib/design/document");
function setup() {
  const content = blankDesignDocument();
  content.nodes = [
    designNodeSchema.parse({
      id: "root",
      type: "artboard",
      name: "Frame",
      parentId: null,
      pageId: "page-1",
      box: { x: 0, y: 0, width: 100, height: 100 },
    }),
  ];
  const snapshot = { revision: 4, content };
  const backend = {
    getDocument: mock(async () => snapshot),
    getDocumentPage: mock(async () => ({
      revision: 4,
      pages: content.pages,
      nodes: content.nodes,
      totalNodes: 1,
      offset: 0,
      nextOffset: null,
      schemaVersion: 1 as const,
      tokens: {},
      designTokens: {},
      warnings: [],
      editedNodeIds: [],
      deletedSourceKeys: [],
      source: undefined,
    })),
    getDocumentRevision: mock(async () => ({ revision: 4 })),
    listComments: mock(async () => ({
      threads: [],
      reactionsAvailable: true,
      canModerateThreads: true,
      nextCursor: null,
    })),
    readEditorContext: mock(async () => ({ available: true, sessions: [] })),
    requestEditorExport: mock(
      async (_userId: string, _fileId: string, request: { requestId: string }) => ({
        type: "export_result" as const,
        requestId: request.requestId,
        revision: 4,
        files: [{ name: "Frame.png", mimeType: "image/png" as const, base64: "aGVsbG8=" }],
        warnings: [],
      }),
    ),
  };
  const tools = new Map<
    string,
    {
      schema: ZodType;
      run: (input: Record<string, unknown>) => Promise<{
        isError?: boolean;
        structuredContent?: object;
        content: { type: string; text: string }[];
      }>;
    }
  >();
  const server = {
    registerTool(name: string, config: { inputSchema: ZodType }, run: unknown) {
      tools.set(name, {
        schema: config.inputSchema,
        run: run as typeof tools extends Map<string, infer T>
          ? T extends { run: infer F }
            ? F
            : never
          : never,
      });
    },
  };
  registerContextTools(server as unknown as McpServer, "authenticated-user", backend);
  const call = (name: string, input: Record<string, unknown>) => {
    const tool = tools.get(name)!;
    return tool.run(tool.schema.parse(input) as Record<string, unknown>);
  };
  return { call, backend, content };
}
test("selection export binds authenticated user, file, revision and page before requesting browser work", async () => {
  const { call, backend } = setup();
  const session_id = crypto.randomUUID();
  const result = await call("export_selection", {
    file_id: "file",
    expected_revision: 4,
    node_ids: ["root"],
    format: "png",
    session_id,
  });
  expect(result.isError).not.toBe(true);
  expect(backend.requestEditorExport.mock.calls[0]).toMatchObject([
    "authenticated-user",
    "file",
    {
      expectedRevision: 4,
      pageId: "page-1",
      ids: ["root"],
      format: "png",
      scale: 1,
      mode: "selection",
    },
    session_id,
  ]);
  expect(backend.getDocumentRevision).toHaveBeenCalledTimes(1);
});
test("selection export rejects missing layers, stale snapshots and intervening changes", async () => {
  const { call, backend } = setup();
  const input = { file_id: "file", expected_revision: 4, node_ids: ["root"], format: "pdf" };
  expect((await call("export_selection", { ...input, node_ids: ["foreign"] })).isError).toBe(true);
  expect((await call("export_selection", { ...input, expected_revision: 3 })).isError).toBe(true);
  expect(backend.requestEditorExport).not.toHaveBeenCalled();
  backend.getDocumentRevision.mockResolvedValueOnce({ revision: 5 });
  expect((await call("export_selection", input)).isError).toBe(true);
});
test("selection export enforces result byte bounds and hides relay diagnostics", async () => {
  const { call, backend } = setup();
  const input = { file_id: "file", expected_revision: 4, node_ids: ["root"], format: "png" };
  backend.requestEditorExport.mockImplementationOnce(async (_u, _f, request) => ({
    type: "export_result",
    requestId: request.requestId,
    revision: 4,
    files: [
      {
        name: "Large.png",
        mimeType: "image/png",
        base64: Buffer.alloc(2000001).toString("base64"),
      },
    ],
    warnings: [],
  }));
  expect((await call("export_selection", input)).isError).toBe(true);
  backend.requestEditorExport.mockRejectedValueOnce(new Error("private relay diagnostic"));
  const rejected = await call("export_selection", input);
  expect(rejected.isError).toBe(true);
  expect(rejected.content[0].text).not.toContain("private relay diagnostic");
});
test("bounded file context includes comments and editor sessions with a final revision check", async () => {
  const { call, backend } = setup();
  const result = await call("get_file_context", { file_id: "file", offset: 1, limit: 25 });
  expect(result.isError).not.toBe(true);
  expect(backend.getDocumentPage.mock.calls as unknown[][]).toEqual([
    ["authenticated-user", "file", 1, 25],
  ]);
  expect(backend.listComments.mock.calls as unknown[][]).toEqual([["file", "authenticated-user"]]);
  backend.getDocumentRevision.mockResolvedValueOnce({ revision: 5 });
  expect((await call("get_file_context", { file_id: "file" })).isError).toBe(true);
});
