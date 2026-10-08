import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { widgetHtml, widgetUri } from "@tidy/gpt-plugin/widget";
import { previewSummarySchema, type DesignPreview } from "@tidy/gpt-plugin/contract";
import { documentAssetIds, parseDesignDocument } from "@bella/design/document";
import { getDocument, getExportAssets } from "@/lib/design/document-service";
import { getDesignFile } from "@/lib/design/service";
import { fontFamilies, googleFontUrl, webFontByName } from "@/lib/design/fonts/catalog";
import { resolveVariantNodes } from "@bella/design/component-variants";
import { mcpToolPolicy } from "./tool-policy";

const services = { getDocument, getExportAssets, getDesignFile };
export function registerPluginTools(
  server: McpServer,
  userId: string,
  backend = services,
  origin = process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
) {
  const appOrigin = new URL(origin).origin;
  server.registerResource(
    "tidy-preview",
    widgetUri,
    { title: "Tidy design preview", mimeType: "text/html;profile=mcp-app" },
    async () => ({
      contents: [
        {
          uri: widgetUri,
          mimeType: "text/html;profile=mcp-app",
          text: widgetHtml,
          _meta: {
            ui: {
              prefersBorder: true,
              domain: appOrigin,
              csp: {
                connectDomains: [],
                resourceDomains: ["https://fonts.googleapis.com", "https://fonts.gstatic.com"],
              },
            },
            "openai/widgetDescription":
              "Tidy design preview with frame selection, refresh, and a link to the editable file.",
            "openai/widgetCSP": {
              connect_domains: [],
              resource_domains: ["https://fonts.googleapis.com", "https://fonts.gstatic.com"],
              redirect_domains: [appOrigin],
            },
          },
        },
      ],
    }),
  );
  server.registerTool(
    "preview_design",
    {
      title: "Preview a Tidy design",
      description:
        "Show a saved Tidy file in the conversation after creating or editing it. The preview includes all visible roots for instant frame selection. Returns its revision and editable file URL. Read get_document before edits. This renders UI for the user; it does not supply a screenshot to the model or verify visual fidelity.",
      inputSchema: z.object({ file_id: z.string().min(1), root_id: z.string().min(1).optional() }),
      outputSchema: previewSummarySchema,
      ...mcpToolPolicy("preview_design"),
      _meta: {
        ...mcpToolPolicy("preview_design")._meta,
        ui: { resourceUri: widgetUri, visibility: ["model", "app"] },
        "openai/outputTemplate": widgetUri,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Opening design…",
        "openai/toolInvocation/invoked": "Design ready",
      },
    },
    async ({ file_id, root_id }) => {
      try {
        const file = await backend.getDesignFile(userId, file_id);
        if (!file) throw new Error("File not found or access denied.");
        const saved = await backend.getDocument(userId, file_id);
        if (!saved) throw new Error("Document not found or access denied.");
        const document = parseDesignDocument(saved.content);
        const nodes = resolveVariantNodes(document.nodes);
        const roots = nodes
          .filter((node) => node.parentId === null && node.visible)
          .map((node) => ({
            id: node.id,
            name: node.name,
            pageId: node.pageId ?? "page-1",
            width: node.box.width,
            height: node.box.height,
          }));
        if (root_id && !roots.some((root) => root.id === root_id))
          throw new Error("Choose a visible frame or component in this file.");
        const assets = await backend.getExportAssets(userId, documentAssetIds(document));
        const fontUrls = new Set<string>();
        for (const node of nodes)
          if (
            node.type === "text" &&
            node.style.fontSource !== "local" &&
            node.style.fontSource !== "system"
          ) {
            for (const family of fontFamilies(node.style.fontFamily ?? "system-ui")) {
              const font = webFontByName.get(family.toLowerCase());
              if (font) fontUrls.add(googleFontUrl(font));
            }
          }
        const summary = {
          fileId: file.id,
          name: file.name,
          revision: saved.revision,
          url: new URL(`/files/${encodeURIComponent(file.id)}`, appOrigin).toString(),
          roots,
          selectedRootId: root_id ?? roots[0]?.id ?? null,
        };
        const preview: DesignPreview = {
          ...summary,
          document,
          fontUrls: [...fontUrls],
          assets: Object.fromEntries(
            assets.map((asset) => [asset.id, `data:${asset.mimeType};base64,${asset.base64}`]),
          ),
        };
        return {
          content: [
            {
              type: "text",
              text: `Opened ${file.name} at revision ${saved.revision}. Editable file: ${summary.url}`,
            },
          ],
          structuredContent: summary,
          _meta: { tidyPreview: preview },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Could not preview the design.",
            },
          ],
          isError: true,
        };
      }
    },
  );
}
