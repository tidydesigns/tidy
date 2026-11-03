import { DESIGN_DOCUMENT_LIMITS } from "./document-limits";

const escapedLessThanPattern = /&lt;/g;
const escapedGreaterThanPattern = /&gt;/g;
const base64WhitespacePattern = /\s/g;
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;

export const FIGMA_LIMITS = {
  inputBytes: 32_000_000,
  expandedBytes: 64_000_000,
  nodes: DESIGN_DOCUMENT_LIMITS.nodes,
  depth: 100,
  assets: 100,
  assetBytes: 2_000_000,
} as const;
function invalid(message: string): never {
  throw new Error(message);
}
export function isFigmaClipboard(html: string) {
  return html.includes("<!--(figma)") || html.includes("&lt;!--(figma)");
}
export function figmaClipboardBytes(html: string): Uint8Array {
  if (html.length > FIGMA_LIMITS.inputBytes * 1.4)
    invalid("Figma selection is too large. Import a smaller selection.");
  html = html.replace(escapedLessThanPattern, "<").replace(escapedGreaterThanPattern, ">");
  const start = html.indexOf("<!--(figma)") + 11;
  const end = html.indexOf("(/figma)-->", start);
  if (start < 11 || end < start)
    invalid("Figma clipboard data is incomplete. Copy the selection again.");
  const value = html.slice(start, end).replace(base64WhitespacePattern, "");
  if (!base64Pattern.test(value)) invalid("Figma clipboard data is invalid.");
  const binary = atob(value);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
