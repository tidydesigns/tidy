import type { DesignNode } from "./document";
import { nodeIndex } from "./node-index";
export type CanvasView = { x: number; y: number; zoom: number };
type RootBounds = { node: DesignNode; bounds: DesignNode["box"] | null };
const rootsByNodes = new WeakMap<readonly DesignNode[], readonly RootBounds[]>();
function canvasRootBounds(nodes: readonly DesignNode[]): readonly RootBounds[] {
  const cached = rootsByNodes.get(nodes);
  if (cached) return cached;
  const roots = nodes
    .filter((node) => node.parentId === null)
    .map((node): RootBounds => {
      if (
        node.type !== "artboard" ||
        node.style.overflow === "visible" ||
        node.style.overflow === "auto" ||
        node.style.blur ||
        node.style.shadow ||
        node.style.shadows?.length
      )
        return { node, bounds: null };
      const angle = ((node.style.rotation ?? 0) * Math.PI) / 180;
      const width =
        Math.abs(Math.cos(angle)) * node.box.width + Math.abs(Math.sin(angle)) * node.box.height;
      const height =
        Math.abs(Math.sin(angle)) * node.box.width + Math.abs(Math.cos(angle)) * node.box.height;
      return {
        node,
        bounds: {
          x: node.box.x + (node.box.width - width) / 2,
          y: node.box.y + (node.box.height - height) / 2,
          width,
          height,
        },
      };
    });
  rootsByNodes.set(nodes, roots);
  return roots;
}
/** Cull only clipped artboards: overflowing free trees keep their layout/content. */
export function visibleCanvasRoots(
  nodes: DesignNode[],
  view: CanvasView,
  size: { width: number; height: number },
  pinnedIds: Iterable<string>,
  measuredOverflowBounds?: ReadonlyMap<string, DesignNode["box"]>,
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
  return canvasRootBounds(nodes)
    .filter(({ node, bounds }) => {
      if (pinned.has(node.id)) return true;
      const measured = measuredOverflowBounds?.get(node.id) ?? bounds;
      return (
        !measured ||
        (measured.x <= right &&
          measured.x + measured.width >= left &&
          measured.y <= bottom &&
          measured.y + measured.height >= top)
      );
    })
    .map(({ node }) => node.id);
}
