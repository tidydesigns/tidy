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
  if (active(css.filter)) return "CSS filter";
  if (active(css.clipPath)) return "CSS clip path";
  // Translation is already represented exactly by getBoundingClientRect.
  // Rotation, skew and scaling also affect descendants and typography.
  if (active(css.transform)) {
    const matrix = css.transform
      .match(/^matrix\(([^)]+)\)$/)?.[1]
      ?.split(",")
      .map(Number);
    if (
      !matrix ||
      matrix.length !== 6 ||
      matrix[0] !== 1 ||
      matrix[1] !== 0 ||
      matrix[2] !== 0 ||
      matrix[3] !== 1
    )
      return "CSS transform";
  }
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

export async function decodeCaptureImage(image: HTMLImageElement, timeoutMs = 3000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      image.decode(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Image timed out.")), Math.max(1, timeoutMs));
      }),
    ]);
  } catch (error) {
    image.removeAttribute("src");
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

// Selection can start inside an editor, including inside an open shadow root.
export function isProtectedElement(element: Element): boolean {
  let editingDisabled = false;
  for (let current: Element | null = element; current;) {
    if (
      ["INPUT", "TEXTAREA", "SELECT", "IFRAME", "OBJECT", "EMBED"].includes(
        current.tagName.toUpperCase(),
      )
    )
      return true;
    const editable = current.getAttribute("contenteditable")?.toLowerCase();
    if (!editingDisabled) {
      if (editable === "false") editingDisabled = true;
      else if (editable === "" || editable === "true" || editable === "plaintext-only") return true;
    }
    const root = current.getRootNode();
    current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return !editingDisabled && document.designMode?.toLowerCase() === "on";
}

// Include overflow descendants: a perspective wrapper can have no height, and the
// laptop's base/shadow may extend beyond the screen's transformed border box.
export function effectBounds(element: Element): DOMRect {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  const pending = [element];
  const deadline = performance.now() + 25;
  let visited = 0;
  while (pending.length) {
    if (++visited > 15000 || performance.now() > deadline)
      throw new Error("Visual group too complex.");
    const node = pending.pop()!;
    const css = getComputedStyle(node);
    if (
      css.display === "none" ||
      css.visibility === "hidden" ||
      css.opacity === "0" ||
      isFullyClipped(css)
    )
      continue;
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
    for (const child of node.children) pending.push(child);
    if (node.shadowRoot) for (const child of node.shadowRoot.children) pending.push(child);
  }
  return Number.isFinite(left)
    ? new DOMRect(left, top, right - left, bottom - top)
    : element.getBoundingClientRect();
}

// Crops can include controls outside the captured subtree. Redact those too,
// including open shadow roots, rather than importing pixels of private values.
export function protectedBounds(): { bounds: DOMRect; backgrounds?: string[] }[] {
  const bounds: ReturnType<typeof protectedBounds> = [];
  let visited = 0;
  const deadline = performance.now() + 25;
  const pending: Element[] = [document.documentElement];
  while (pending.length) {
    if (++visited > 15000 || performance.now() > deadline)
      throw new Error("Page too complex for safe screenshot fallbacks.");
    const element = pending.pop()!;
    const css = getComputedStyle(element);
    if (css.display === "none" || css.opacity === "0") continue;
    const uninspectable = element.tagName.includes("-") && !element.shadowRoot;
    if (
      isProtectedElement(element) ||
      // A closed shadow tree cannot be inspected for private controls.
      uninspectable
    ) {
      const box = element.getBoundingClientRect();
      if (box.width && box.height) {
        let backgrounds: string[] | undefined;
        if (!uninspectable) {
          backgrounds = [];
          for (let current: Element | null = element; current;) {
            backgrounds.unshift(getComputedStyle(current).backgroundColor);
            const root = current.getRootNode();
            current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
          }
        }
        bounds.push({ bounds: box, backgrounds });
      }
      continue;
    }
    for (const child of element.children) pending.push(child);
    if (element.shadowRoot) for (const child of element.shadowRoot.children) pending.push(child);
  }
  return bounds;
}

// Screen-reader helpers have layout boxes but no painted pixels. Do not expose
// their text or spend raster slots attempting to capture an empty clipping area.
export function isFullyClipped(css: CSSStyleDeclaration): boolean {
  const rect = css.clip
    ?.match(/^rect\(([^)]+)\)$/)?.[1]
    ?.match(/-?[\d.]+px/g)
    ?.map(parseFloat);
  if (rect?.length === 4 && ["absolute", "fixed"].includes(css.position))
    return rect[2]! <= rect[0]! || rect[1]! <= rect[3]!;
  return false;
}

export function hasPaintedPseudo(css: CSSStyleDeclaration): boolean {
  if (
    !css.content ||
    ["none", "normal"].includes(css.content) ||
    css.display === "none" ||
    css.visibility === "hidden" ||
    css.opacity === "0"
  )
    return false;
  if (!['""', "''"].includes(css.content)) return true;
  const opaque = (color: string) =>
    Boolean(color && color !== "transparent" && !/rgba\([^)]*,\s*0\s*\)/.test(color));
  return Boolean(
    opaque(css.backgroundColor) ||
    (css.backgroundImage && css.backgroundImage !== "none") ||
    (css.boxShadow && css.boxShadow !== "none") ||
    ["Top", "Right", "Bottom", "Left"].some(
      (side) =>
        parseFloat(css.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
        opaque(css.getPropertyValue(`border-${side.toLowerCase()}-color`)),
    ),
  );
}
