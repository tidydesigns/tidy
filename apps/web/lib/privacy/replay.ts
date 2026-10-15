// Replay defaults to private text. Only reviewed application chrome opts in;
// user content must never inherit that opt-in from a surrounding control.
export function replayText(text: string, element?: HTMLElement | null) {
  return element?.closest("[data-ph-public]") &&
    !element.closest(".ph-mask, .ph-no-capture, [data-ph-private], [contenteditable]")
    ? text
    : "[hidden]";
}

export function replayAttribute(name: string, value: string, element?: Element) {
  // Preserve layout without leaking labels, hrefs, IDs, data attributes or values.
  if (name === "class") return value;
  if (
    element?.namespaceURI === "http://www.w3.org/2000/svg" &&
    element.closest("[data-ph-public]") &&
    !element.closest("[data-ph-private], .ph-no-capture, [data-node-id]") &&
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
    if (!element || element.closest(".ph-no-capture, [data-ph-private], [data-node-id]")) return "";
    return value.replace(/url\(([^)]*)\)/gi, (match, raw: string) => {
      try {
        const url = new URL(raw.trim().replace(/^["']|["']$/g, ""), location.origin);
        return url.origin === location.origin && /^\/icons\/[\w/.-]+\.svg$/.test(url.pathname)
          ? match
          : "none";
      } catch {
        return "none";
      }
    });
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
