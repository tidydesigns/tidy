// React refs maintain this registry; overlays never scan the entire canvas to
// find one selected layer. Weak keys release closed editors automatically.
const registries = new WeakMap<HTMLElement, ReadonlyMap<string, HTMLElement>>();
const empty = new Map<string, HTMLElement>();
export function attachCanvasElements(
  canvas: HTMLElement,
  elements: ReadonlyMap<string, HTMLElement>,
) {
  registries.set(canvas, elements);
}
export function canvasElements(
  canvas: HTMLElement | null | undefined,
): ReadonlyMap<string, HTMLElement> {
  return canvas ? (registries.get(canvas) ?? empty) : empty;
}
export function selectedElements(
  canvas: HTMLElement | null | undefined,
  ids: Iterable<string>,
): HTMLElement[] {
  const elements = canvasElements(canvas);
  return Array.from(ids).flatMap((id) => {
    const element = elements.get(id);
    return element ? [element] : [];
  });
}

/** Read only selected elements, once each, and allocate no intermediate rectangle arrays. */
export function selectionContainsPoint(
  canvas: HTMLElement | null,
  ids: string[],
  x: number,
  y: number,
): boolean {
  const elements = canvasElements(canvas);
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const id of ids) {
    const element = elements.get(id);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  return x >= left && x <= right && y >= top && y <= bottom;
}
