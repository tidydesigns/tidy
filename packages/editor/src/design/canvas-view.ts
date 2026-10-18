import type { DesignNode } from "./document";
import type { CanvasView } from "./canvas-culling";

export const CANVAS_FIT_PADDING = 120;

export function fitCanvasView(nodes: DesignNode[], width: number, height: number): CanvasView {
  const roots = nodes.filter((node) => node.parentId === null);
  if (!roots.length) return { zoom: 1, x: 0, y: 0 };
  const left = Math.min(...roots.map((node) => node.box.x));
  const top = Math.min(...roots.map((node) => node.box.y));
  const right = Math.max(...roots.map((node) => node.box.x + node.box.width));
  const bottom = Math.max(...roots.map((node) => node.box.y + node.box.height));
  // A panel transition or streamed layout can briefly measure less than the
  // padding. Negative scales also invert culling bounds and hide every root.
  const zoom = Math.min(
    1,
    Math.max(1, width - CANVAS_FIT_PADDING) / Math.max(1, right - left),
    Math.max(1, height - CANVAS_FIT_PADDING) / Math.max(1, bottom - top),
  );
  return {
    zoom,
    x: (width - (right - left) * zoom) / 2 - left * zoom,
    y: (height - (bottom - top) * zoom) / 2 - top * zoom,
  };
}
