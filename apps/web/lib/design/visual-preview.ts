import { resolvedDocumentNodes } from "@bella/design/design-tokens";
import type { DesignDocument } from "@bella/design/document";
import { componentExportDocument } from "./code-export";
import type {
  VisualPreviewData,
  VisualPreviewState,
  VisualPreviewView,
} from "./visual-preview-types";
import { VISUAL_PREVIEW_MAX_BYTES, type PreviewFonts } from "./visual-preview-fonts";
import { visualPreviewRuntime } from "./visual-preview-runtime.generated";

export type PreviewSelection = {
  node_id: string;
  label?: string;
  variant?: string;
  state?: VisualPreviewState;
};

export function visualPreviewViews(
  document: DesignDocument,
  selections: PreviewSelection[],
): VisualPreviewView[] {
  return selections.map((selection) => {
    const content = componentExportDocument(document, selection.node_id);
    const root = resolvedDocumentNodes(content).find((node) => node.id === selection.node_id)!;
    if (!root.visible) throw new Error("Choose a visible frame or component.");
    const variants = Object.keys(root.variants?.options ?? {});
    if (selection.variant && !variants.includes(selection.variant))
      throw new Error(`Variant ${selection.variant} is unavailable on ${root.name}.`);
    const rendered = resolvedDocumentNodes(document);
    let frame = rendered.find((node) => node.id === selection.node_id);
    const visited = new Set<string>();
    while (frame?.parentId && !visited.has(frame.id)) {
      visited.add(frame.id);
      frame = rendered.find((node) => node.id === frame!.parentId);
    }
    return {
      nodeId: root.id,
      label: selection.label ?? root.name,
      document: content,
      variants,
      initialVariant: selection.variant ?? root.variant ?? root.variants?.default,
      initialState: selection.state ?? "default",
      width: Math.max(
        1,
        root.widthMode === "fixed" ? root.box.width : (frame?.box.width ?? root.box.width),
      ),
    };
  });
}

export function buildVisualPreview(data: VisualPreviewData, fonts: PreviewFonts) {
  const warnings = [...new Set([...data.warnings, ...fonts.warnings])];
  const json = JSON.stringify({ ...data, warnings }).replaceAll("<", "\\u003c");
  // No request to Tidy or a CDN is needed inside the opaque T3 iframe.
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>${fonts.css.replaceAll("<", "\\3c ")}
*{box-sizing:border-box}html,body{margin:0;padding:0}body{color:var(--foreground,#282a28);font-family:var(--font-sans,system-ui);overflow-wrap:anywhere}.tidy-controls{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 10px;align-items:center}.tidy-controls button{font:inherit;font-size:12px;cursor:pointer;padding:4px 8px;border:1px solid var(--border,#d0d0d0);border-radius:5px;background:var(--background,#fff);color:var(--foreground,#282a28)}.tidy-controls button[aria-pressed=true]{background:var(--accent,#e7e7e7)}.tidy-controls button:focus-visible{outline:2px solid var(--ring,#777);outline-offset:2px}.tidy-viewport{width:100%;overflow:hidden}[data-tidy-design]{color:#282a28;font-family:system-ui;font-size:16px;line-height:1.5;overflow-wrap:normal}footer,details{font-size:11px;margin-top:8px;color:var(--muted-foreground,#777)}details li{margin:5px 0}summary{cursor:pointer}
</style></head><body><div id="tidy-preview"></div><script id="tidy-preview-data" type="application/json">${json}</script><script>${visualPreviewRuntime.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  const byteSize = Buffer.byteLength(html, "utf8");
  if (byteSize > VISUAL_PREVIEW_MAX_BYTES)
    throw new Error(
      `Visual preview is ${byteSize} bytes; T3 accepts at most ${VISUAL_PREVIEW_MAX_BYTES}. Select fewer frames or use smaller source images. No content was truncated.`,
    );
  return { html, byteSize, warnings };
}
