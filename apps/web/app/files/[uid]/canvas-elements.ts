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
