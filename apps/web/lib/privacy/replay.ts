import { iconSources } from "@tidy/editor/components/ui/icon-sources";

// These are the exact URLs emitted by the bundler for our checked-in iconpack.
// Never permit an entire asset directory, uploads, or URLs with user data appended.
const replayIconSources = Object.values(iconSources);
const privateSelector =
  ".ph-mask, .ph-no-capture, [data-ph-private], [contenteditable], [data-node-id], [data-design-font], input, textarea, select";

// Replay defaults to private text. Only reviewed application chrome opts in;
// user content must never inherit that opt-in from a surrounding control.
export function replayText(text: string, element?: HTMLElement | null) {
  if (!text.trim()) return text;
  return element?.closest("[data-ph-public]") && !element.closest(privateSelector)
    ? text
    : "[hidden]";
}

export function replayAttribute(name: string, value: string, element?: Element) {
  // Preserve layout without leaking labels, hrefs, IDs, data attributes or values.
  const privateContent = element?.closest(privateSelector);
  if (!privateContent && name === "aria-label" && element?.hasAttribute("data-ph-control-label"))
    return element.getAttribute("data-ph-control-label") ?? "";
  if (
    !privateContent &&
    /^(aria-label|title)$/.test(name) &&
    element?.hasAttribute("data-ph-public-label")
  )
    return value;
  if (name === "class") return value;
  if (
    element?.namespaceURI === "http://www.w3.org/2000/svg" &&
    element.closest("[data-ph-public]") &&
    !privateContent &&
    /^(viewBox|d|x|y|x1|y1|x2|y2|cx|cy|r|rx|ry|points|fill|stroke|stroke-width|stroke-linecap|stroke-linejoin|fill-rule|clip-rule)$/.test(
      name,
    ) &&
    !/url\s*\(/i.test(value)
  )
    return value;
  if (name === "data-theme" && ["light", "dark"].includes(value)) return value;
  if (name === "data-side" && ["left", "right"].includes(value)) return value;
  if (/^data-(open|visible|animate-enter)$/.test(name) && /^(true|false)$/.test(value))
    return value;
  if (name === "data-canvas-control") return "";
  if (name === "_cssText" && element?.matches("style, link[rel='stylesheet']")) return value;
  if (name === "style") {
    if (!element || privateContent) return "";
    // Quoted CSS URLs may contain parentheses; redact the complete token.
    return value.replace(
      /url\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^)]*)\s*\)/gi,
      (match, raw: string) => {
        try {
          const url = raw.trim().replace(/^["']|["']$/g, "");
          // Normalize only our manifest. Resolving a candidate could discard
          // private path segments (secret/../) while recording the original URL.
          return replayIconSources.some(
            (source) => source === url || new URL(source, location.href).href === url,
          )
            ? match
            : "none";
        } catch {
          return "none";
        }
      },
    );
  }
  if (/^(width|height|colspan|rowspan)$/.test(name) && /^\d{1,5}$/.test(value)) return value;
  if (
    /^rr_(width|height|left|top|position|transform|display|scrollleft|scrolltop|open_mode)$/.test(
      name,
    )
  )
    return value;
  return "";
}
