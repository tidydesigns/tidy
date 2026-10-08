// Effects whose rendered pixels cannot be recovered from an image URL and an axis-aligned box.
export function rasterEffect(css: CSSStyleDeclaration): string | undefined {
  const active = (value: string) => Boolean(value && value !== "none" && value !== "normal");
  if (
    active(css.getPropertyValue("mask-image")) ||
    active(css.getPropertyValue("-webkit-mask-image"))
  )
    return "CSS mask";
  if (
    active(css.perspective) ||
    css.transform?.startsWith("matrix3d(") ||
    css.transformStyle === "preserve-3d"
  )
    return "3D perspective";
  return undefined;
}

export type CaptureViewport = { width: number; height: number; scrollX: number; scrollY: number };
export const currentViewport = (): CaptureViewport => ({
  width: window.innerWidth,
  height: window.innerHeight,
  scrollX: window.scrollX,
  scrollY: window.scrollY,
});
export function sameViewport(a: CaptureViewport, b: CaptureViewport) {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.scrollX === b.scrollX &&
    a.scrollY === b.scrollY
  );
}

export function intersectBounds(a: DOMRect, b: DOMRect): DOMRect | undefined {
  const left = Math.max(a.left, b.left),
    top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right),
    bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top
    ? new DOMRect(left, top, right - left, bottom - top)
    : undefined;
}

// Include overflow descendants: a perspective wrapper can have no height, and the
// laptop's base/shadow may extend beyond the screen's transformed border box.
export function effectBounds(element: Element): DOMRect {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  const visit = (node: Element) => {
    const css = getComputedStyle(node);
    if (css.display === "none" || css.visibility === "hidden") return;
    const box = node.getBoundingClientRect();
    if (box.width && box.height) {
      // Computed shadows serialize colors as rgb(...); remove them before reading lengths.
      let outset = 0;
      for (const shadow of (css.boxShadow || "none").replace(/rgba?\([^)]*\)/g, "").split(",")) {
        if (shadow.includes("inset")) continue;
        const lengths = shadow.match(/-?[\d.]+px/g)?.map(Number.parseFloat) ?? [];
        if (lengths.length >= 2)
          outset = Math.max(
            outset,
            Math.max(Math.abs(lengths[0]!), Math.abs(lengths[1]!)) +
              (lengths[2] ?? 0) * 1.5 +
              Math.max(0, lengths[3] ?? 0),
          );
      }
      left = Math.min(left, box.left - outset);
      top = Math.min(top, box.top - outset);
      right = Math.max(right, box.right + outset);
      bottom = Math.max(bottom, box.bottom + outset);
    }
    for (const child of node.children) visit(child);
    if (node.shadowRoot) for (const child of node.shadowRoot.children) visit(child);
  };
  visit(element);
  return Number.isFinite(left)
    ? new DOMRect(left, top, right - left, bottom - top)
    : element.getBoundingClientRect();
}

// Crops can include controls outside the captured subtree. Redact those too,
// including open shadow roots, rather than importing pixels of private values.
export function protectedBounds(): DOMRect[] {
  const bounds: DOMRect[] = [];
  let visited = 0;
  const visit = (element: Element) => {
    if (++visited > 15000) throw new Error("Page too complex for safe screenshot fallbacks.");
    if (
      element.matches(
        'input, textarea, select, iframe, object, embed, [contenteditable]:not([contenteditable="false"])',
      )
    ) {
      const box = element.getBoundingClientRect();
      if (box.width && box.height) bounds.push(box);
      return;
    }
    for (const child of element.children) visit(child);
    if (element.shadowRoot) for (const child of element.shadowRoot.children) visit(child);
  };
  visit(document.documentElement);
  return bounds;
}
