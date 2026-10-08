import type { DesignNode } from "./document";
import { nodeIndex } from "./node-index";
export type CanvasView = { x: number; y: number; zoom: number };
/** Cull only clipped artboards: overflowing free trees keep their layout/content. */
export function visibleCanvasRoots(
  nodes: DesignNode[],
  view: CanvasView,
  size: { width: number; height: number },
  pinnedIds: Iterable<string>,
): string[] {
  const byId = nodeIndex(nodes),
    pinned = new Set<string>();
  for (const id of pinnedIds) {
    let node = byId.get(id);
    while (node?.parentId) node = byId.get(node.parentId);
    if (node) pinned.add(node.id);
  }
  const margin = 300 / view.zoom;
  const left = -view.x / view.zoom - margin,
    top = -view.y / view.zoom - margin;
  const right = (size.width - view.x) / view.zoom + margin,
    bottom = (size.height - view.y) / view.zoom + margin;
  return nodes
    .filter((node) => {
      if (node.parentId !== null) return false;
      if (
        pinned.has(node.id) ||
        node.type !== "artboard" ||
        node.style.overflow === "visible" ||
        node.style.overflow === "auto" ||
        node.style.blur ||
        node.style.shadow ||
        node.style.shadows?.length
      )
        return true;
      const angle = ((node.style.rotation ?? 0) * Math.PI) / 180;
      const width =
        Math.abs(Math.cos(angle)) * node.box.width + Math.abs(Math.sin(angle)) * node.box.height;
      const height =
        Math.abs(Math.sin(angle)) * node.box.width + Math.abs(Math.cos(angle)) * node.box.height;
      const x = node.box.x + (node.box.width - width) / 2,
        y = node.box.y + (node.box.height - height) / 2;
      return x <= right && x + width >= left && y <= bottom && y + height >= top;
    })
    .map((node) => node.id);
}
