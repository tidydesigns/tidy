import type { DesignNode } from "./document";

type Box = DesignNode["box"];
type PositionedNode = Pick<DesignNode, "id" | "parentId" | "box">;

export function canvasWorldPoint(
  client: { x: number; y: number },
  origin: { x: number; y: number },
  view: { x: number; y: number; zoom: number },
  snapPixels = true,
) {
  const snap = (value: number) => (snapPixels ? Math.round(value) : value);
  return {
    x: Math.max(-100000, Math.min(100000, snap((client.x - origin.x - view.x) / view.zoom))),
    y: Math.max(-100000, Math.min(100000, snap((client.y - origin.y - view.y) / view.zoom))),
  };
}

export function absoluteNodePosition(nodes: PositionedNode[], id: string) {
  let x = 0;
  let y = 0;
  let current = nodes.find((node) => node.id === id);
  while (current) {
    x += current.box.x;
    y += current.box.y;
    current = nodes.find((node) => node.id === current?.parentId);
  }
  return { x, y };
}

export function containingDrawParent(
  nodes: PositionedNode[],
  startParentId: string | null,
  box: Box,
): string | null {
  let parentId = startParentId;
  while (parentId) {
    const parent = nodes.find((node) => node.id === parentId);
    if (!parent) return null;
    const position = absoluteNodePosition(nodes, parentId);
    if (
      box.x >= position.x &&
      box.y >= position.y &&
      box.x + box.width <= position.x + parent.box.width &&
      box.y + box.height <= position.y + parent.box.height
    )
      return parentId;
    parentId = parent.parentId;
  }
  return null;
}
