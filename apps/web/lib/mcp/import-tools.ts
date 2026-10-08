import { mcpToolPolicy } from "@/lib/mcp/tool-policy";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { designNodeSchema } from "@bella/design/document";
import { MAX_CAPTURE_BYTES, webCaptureSchema } from "@bella/design/web-capture";
import { browserCaptureScript, browserCaptureSourceHash } from "./browser-capture.generated";
import { importWebCapture } from "@/lib/design/web-capture-service";
import type { McpActivity } from "./activity";

export const importGuidance = {
  capabilities: {
    serverBrowserCapture: false,
    agentBrowserCapture: true,
    htmlCssExecution: false,
    renderedCaptureImport: true,
    editableText: true,
    svgAssets: true,
    editableCssMasks: false,
    editablePerspective3d: false,
    rasterizedMasks: true,
    rasterizedPerspective3d: true,
  },
  workflow: [
    "Call get_browser_capture_script and run its script in the agent harness's browser to capture a rendered page. No extension installation is required. The extension uses the same capture engine. The MCP server cannot open a URL or execute HTML/CSS. Without a browser, label the result a source-based approximation.",
    "Record viewport width/height, device scale, scroll position and visible state. Wait for fonts and images and pause animation before measuring. Use rendered bounds and computed styles; never guess coordinates from JSX.",
    "Inventory all visible assets, including inline SVG, icon libraries, external SVG use references, CSS backgrounds and generated content. Resolve SVG currentColor and inherited styles, viewBox and referenced symbols into a self-contained SVG. Upload it with put_asset; reference it from a vector node. Do not replace icons with Unicode or omit them silently.",
    "Keep supported text and controls editable. Match font family, weight, line height, wrapping, image fit/crop, clipping and stacking order. Report fonts unavailable in the editor.",
    "For new UI use get_design_guidance and compose_component. For measured imports preserve the source's layout rules where supported: explicit flex/grid alignment, padding, gap and child sizing. Keep labels/icons together in flow and supply semantics for native button/link code export. Inspect validate_import.layout and resolve errors before committing.",
    "For unsupported masks, filters, blend effects or 3D transforms, use a rendered image of the smallest complete visual group. Preserve transparent edges when possible. A raw forest image loses its CSS fade; an untransformed laptop asset loses perspective. Do not draw both flattened descendants and their replacement. If a screenshot crop includes overlapping content, capture an isolated group or explicitly report the flattening of the entire composite.",
    "Never include private form values or credentials, including in screenshot fallbacks. Sanitize the rendered state before capturing. Do not send environment files or private local paths.",
    "Use put_asset plus create_import, put_import_chunk, validate_import and commit_import for staged imports, large payloads and retry-safe publishing. Use import_web_capture only for a capture produced by the browser script or extension; it appends a new copy on every call and does not launch a browser or improve the capture automatically.",
    "Attach node-specific warnings for each flattened, approximated or omitted region. validate_import checks structure and assets, not visual fidelity. Read the committed document back, then compare the rendered Tidy artboard with the source at the same viewport and state. Check icons, forest masks, laptop perspective, font wrapping and geometry. Fix discrepancies before claiming completion; if comparison is unavailable, explicitly report visually unverified.",
  ],
  report: [
    "File URL and captured viewport/state",
    "Editable layers",
    "Flattened layers and reasons",
    "Missing assets/fonts and approximations",
    "Visual comparison performed and remaining differences",
  ],
};

const result = (value: object) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

export function registerImportTools(
  server: McpServer,
  userId: string,
  importCapture = importWebCapture,
  activity?: McpActivity,
) {
  server.registerTool(
    "get_import_guidance",
    {
      ...mcpToolPolicy("get_import_guidance"),
      description:
        "Read before importing a website or codebase screen. Returns current node/capture schemas, asset requirements, unsupported-effect fallbacks and visual verification workflow.",
      annotations: { ...mcpToolPolicy("get_import_guidance").annotations, readOnlyHint: true },
    },
    async () =>
      result({
        ...importGuidance,
        nodeSchema: z.toJSONSchema(designNodeSchema),
        captureSchema: z.toJSONSchema(webCaptureSchema),
        maxCaptureBytes: MAX_CAPTURE_BYTES,
      }),
  );

  server.registerTool(
    "get_browser_capture_script",
    {
      ...mcpToolPolicy("get_browser_capture_script"),
      description:
        "Get a self-contained browser script for website-to-design capture. Run it in YOUR browser harness, take a viewport screenshot, then call its capture API and submit the result to import_web_capture. Preserves CSS masks as transparent assets and perspective as screenshot composites. No extension required; the server does not browse.",
      annotations: {
        ...mcpToolPolicy("get_browser_capture_script").annotations,
        readOnlyHint: true,
      },
    },
    async () =>
      result({
        version: 1,
        sourceHash: browserCaptureSourceHash,
        script: browserCaptureScript,
        api: "globalThis.__tidyCapture",
        steps: [
          "Open the source route in your browser at the requested viewport and representative state. Install script with the harness's page-context JavaScript facility (for Playwright: page.addScriptTag({content: script})).",
          "Call await globalThis.__tidyCapture.prepare({selector}) in the page. Omit selector to capture the whole page. Retain the returned viewport metadata locally.",
          "Take a PNG screenshot of the visible viewport, not a full-page screenshot. Keep the same tab, URL, viewport, scroll and animation state. Bring complete perspective groups into view; offscreen screenshot effects cannot be reconstructed.",
          "Call await globalThis.__tidyCapture.capture({selector, screenshot, viewport}) in the same page, where screenshot is a data:image/png;base64,... URL and viewport is prepare()'s result. The result is the capture object for import_web_capture. Keep large image bytes in harness variables/files instead of printing them into the conversation.",
          "Call import_web_capture with organization_id, optional file_id and capture. Each call appends a new copy. For large payloads or retry-safe writes, use put_asset and staged imports instead.",
          "Read get_document, open the returned Tidy file in your browser, and compare the rendered artboard to the source at matching scale and viewport. Inspect icons, mask edges, perspective, type wrapping and stacking. The capture warnings list flattened, redacted and approximated content; do not claim a 1:1 result without this visual check.",
        ],
        limitations: [
          "Browser execution is provided by the user's agent harness, not this MCP server.",
          "Mask groups are raster assets, not editable masks. Perspective crops include backgrounds/overlaps and have no editable descendants.",
          "Unreadable assets, fonts, offscreen effects and complex stacking can still require correction. Private form controls and embedded content are redacted from screenshot fallbacks.",
        ],
      }),
  );

  server.registerTool(
    "import_web_capture",
    {
      ...mcpToolPolicy("import_web_capture"),
      description:
        "Import an already captured rendered page from get_browser_capture_script or the extension (editable nodes and raster assets). Does not browse a URL or accept HTML. Appends a new copy on EVERY call; do not blindly retry after a timeout—check list_files/get_document first. For retry-safe publishing use the staged import tools. Read get_import_guidance first.",
      inputSchema: z.object({
        organization_id: z.string().min(1),
        file_id: z.uuid().optional(),
        capture: webCaptureSchema,
      }),
      annotations: {
        ...mcpToolPolicy("import_web_capture").annotations,
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ organization_id, file_id, capture }) => {
      try {
        if (new TextEncoder().encode(JSON.stringify(capture)).byteLength > MAX_CAPTURE_BYTES)
          throw new Error(
            "Capture exceeds 16 MB. Use staged import tools or capture a smaller region.",
          );
        const input = { userId, organizationId: organization_id, fileId: file_id, capture };
        if (activity)
          return await activity.run("import_web_capture", { file_id }, async (observe) =>
            result(await importCapture(userId, input, undefined, observe)),
          );
        return result(await importCapture(userId, input));
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : "Could not import capture.",
            },
          ],
          isError: true as const,
        };
      }
    },
  );
}
