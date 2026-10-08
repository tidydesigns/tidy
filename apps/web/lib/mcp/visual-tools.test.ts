import { describe, expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";

mock.module("server-only", () => ({}));
const { buttonExample } = await import("./design-tools");
const { componentTreeSchema, composeComponent } = await import("@/lib/design/compose-component");
const { registerVisualTools, visualPreviewInput } = await import("./visual-tools");
const { packagePreviewFonts, VISUAL_PREVIEW_MAX_BYTES } =
  await import("@/lib/design/visual-preview-fonts");
const { buildVisualPreview, visualPreviewViews } = await import("@/lib/design/visual-preview");
const { requiredMcpScopes } = await import("./scopes");

function setup() {
  const document = composeComponent(componentTreeSchema.parse(buttonExample)).document;
  const backend = {
    getDocument: mock(async (): Promise<{ revision: number; content: typeof document } | null> => ({
      revision: 4,
      content: document,
    })),
    getFileImage: mock(async () => ({
      revision: 4,
      fileId: "file",
      assetId: "asset",
      mimeType: "image/png",
      byteSize: 1,
      base64: "AA==",
      layers: [],
    })),
    packagePreviewFonts: mock(async () => ({ css: "", warnings: [] as string[] })),
  };
  let run!: (
    args: ReturnType<typeof visualPreviewInput.parse>,
  ) => Promise<{ isError?: boolean; structuredContent?: object; content: { text: string }[] }>;
  const server = {
    registerTool(_name: string, _config: unknown, callback: typeof run) {
      run = callback;
    },
  };
  registerVisualTools(server as unknown as McpServer, "member", backend);
  const call = (extra = {}) =>
    run(
      visualPreviewInput.parse({
        file_id: "file",
        selections: [{ node_id: "new-thread" }],
        ...extra,
      }),
    );
  return { document, backend, call };
}

describe("authenticated visual MCP export", () => {
  test("packages the shared renderer, local controls, revision, and read scope", async () => {
    const { backend, call } = setup();
    const result = await call();
    const value = JSON.parse(JSON.stringify(result.structuredContent));
    expect(result.isError).toBeUndefined();
    expect(value.revision).toBe(4);
    expect(value.html).toContain('id="tidy-preview-data"');
    expect(value.html).toContain("connect-src 'none'");
    expect(value.views[0].variants).toEqual(["primary", "secondary", "danger"]);
    expect(value.byteSize).toBeLessThanOrEqual(VISUAL_PREVIEW_MAX_BYTES);
    for (const name of ["Paper.js", "React", "Zod"]) {
      const license = await Bun.file(
        new URL(`../../../../licenses/bundled/${name}.txt`, import.meta.url),
      ).text();
      expect(value.html).toContain(license.trim());
    }
    expect(backend.getDocument.mock.calls as unknown[][]).toEqual([
      ["member", "file"],
      ["member", "file"],
    ]);
    expect(
      requiredMcpScopes({ method: "tools/call", params: { name: "export_visual_preview" } }),
    ).toEqual(["mcp:read"]);
  });
  test("denied or revoked files never return HTML or read assets", async () => {
    const { backend, call } = setup();
    backend.getDocument.mockResolvedValue(null);
    expect((await call()).isError).toBe(true);
    expect(backend.getFileImage).not.toHaveBeenCalled();
    const second = setup();
    second.backend.getDocument
      .mockResolvedValueOnce({ revision: 4, content: second.document })
      .mockResolvedValueOnce(null);
    expect((await second.call()).isError).toBe(true);
  });
  test("embeds assets once and reports missing images instead of leaking private URLs", async () => {
    const { document, backend, call } = setup();
    const assetId = "00000000-0000-4000-8000-000000000001";
    document.nodes[1].type = "image";
    document.nodes[1].assetId = assetId;
    const result = await call({
      selections: [
        { node_id: "new-thread", label: "Main" },
        { node_id: "new-thread", label: "Branch", variant: "secondary", state: "hover" },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(backend.getFileImage.mock.calls as unknown[][]).toEqual([["member", "file", assetId]]);
    expect(result.content[0].text).toContain("data:image/png;base64,AA==");
    backend.getFileImage.mockRejectedValue(new Error("private bucket diagnostic"));
    const missing = await call();
    expect(missing.content[0].text).toContain("missing or inaccessible");
    expect(missing.content[0].text).not.toContain("private bucket diagnostic");
  });
  test("refuses mixed revisions and unknown variants", async () => {
    const { backend, document, call } = setup();
    expect(
      (await call({ selections: [{ node_id: "new-thread", variant: "other" }] })).isError,
    ).toBe(true);
    backend.getDocument
      .mockResolvedValueOnce({ revision: 4, content: document })
      .mockResolvedValueOnce({ revision: 5, content: document });
    expect((await call()).content[0].text).toContain("changed during export");
  });
  test("escapes source content, strips private editor paths, and enforces UTF-8 payload size", () => {
    const { document } = setup();
    document.nodes[1].text = "</script><script>parent.pwned=true</script> 🦊";
    document.nodes[1].sourcePath = "private/project/secret.tsx";
    const data = {
      revision: 1,
      views: visualPreviewViews(document, [{ node_id: "new-thread" }]),
      assets: {},
      warnings: [],
    };
    const result = buildVisualPreview(data, { css: "", warnings: [] });
    expect(result.html).not.toContain("<script>parent.pwned");
    expect(result.html).not.toContain("/private/project/secret.tsx");
    expect(result.byteSize).toBe(Buffer.byteLength(result.html));
    expect(() =>
      buildVisualPreview({ ...data, warnings: ["🦊".repeat(100000)] }, { css: "", warnings: [] }),
    ).toThrow("No content was truncated");
    expect(() =>
      visualPreviewInput.parse({
        file_id: "file",
        selections: Array(13).fill({ node_id: "root" }),
      }),
    ).toThrow();
  });
  test("font packaging embeds only allowlisted resources and reports unavailable faces", async () => {
    const { document } = setup();
    document.nodes[1].style.fontFamily = "Instrument Sans";
    document.nodes[1].style.fontSource = "web";
    const fetcher = mock(async (input: string | URL | Request) =>
      String(input).startsWith("https://fonts.googleapis.com/")
        ? new Response(
            '@font-face{font-family:"Instrument Sans";font-weight:400;src:url(https://fonts.gstatic.com/f.woff2) format("woff2")}',
          )
        : new Response(new Uint8Array([1, 2, 3])),
    );
    const fonts = await packagePreviewFonts([document], fetcher);
    expect(fonts.css).toContain("data:font/woff2;base64,AQID");
    expect(fonts.css).not.toContain("https://fonts.gstatic.com");
    expect(fonts.warnings).toEqual([]);
    const hostile = mock(
      async () =>
        new Response(
          '@font-face{font-family:"Instrument Sans";font-weight:400;src:url(http://127.0.0.1/secret)}',
        ),
    );
    expect(
      (await packagePreviewFonts([document], hostile as unknown as typeof fetch)).warnings[0],
    ).toContain("could not be embedded");
    expect(hostile).toHaveBeenCalledTimes(1);
    document.nodes[1].style.fontSource = "local";
    expect((await packagePreviewFonts([document], fetcher)).warnings[0]).toContain(
      "device-dependent",
    );
  });
  test("preview widths and packaged fonts resolve typed token bindings", async () => {
    const { document } = setup();
    document.designTokens = {
      previewWidth: { type: "dimension", value: 321 },
      previewFont: {
        type: "typography",
        value: { fontFamily: "Instrument Sans", fontSource: "web", fontWeight: 400 },
      },
    };
    document.nodes[0].tokenBindings = { width: "previewWidth" };
    document.nodes[1].style.fontFamily = "monospace";
    document.nodes[1].tokenBindings = { textStyle: "previewFont" };
    const views = visualPreviewViews(document, [{ node_id: "new-thread" }]);
    expect(views[0].width).toBe(321);
    const fetcher = mock(async (input: string) =>
      input.startsWith("https://fonts.googleapis.com/")
        ? new Response(
            '@font-face{font-family:"Instrument Sans";font-weight:400;src:url(https://fonts.gstatic.com/f.woff2)}',
          )
        : new Response(new Uint8Array([1, 2, 3])),
    );
    const fonts = await packagePreviewFonts(
      views.map((view) => view.document),
      fetcher,
    );
    expect(fonts.css).toContain("data:font/woff2;base64,AQID");
    expect(fonts.warnings).toEqual([]);
  });
  test("generated runtime follows the shared renderer", async () => {
    const result = Bun.spawn(
      ["bun", "apps/web/scripts/generate-visual-preview-runtime.ts", "--check"],
      { cwd: new URL("../../../../", import.meta.url).pathname, stderr: "pipe" },
    );
    const stderr = await new Response(result.stderr).text();
    expect(await result.exited, stderr).toBe(0);
  });
});
