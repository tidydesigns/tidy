import type { DesignNode } from "./document";
import { reparentGeometry, type MeasuredBoxes } from "./reparent-geometry";
import { boundingBox } from "./snapping";

type Point = { x: number; y: number };
type Box = DesignNode["box"];

function visualBounds({ box, style }: Pick<DesignNode, "box" | "style">): Box {
  const angle = ((style.rotation ?? 0) * Math.PI) / 180;
  const width = Math.abs(Math.cos(angle)) * box.width + Math.abs(Math.sin(angle)) * box.height;
  const height = Math.abs(Math.sin(angle)) * box.width + Math.abs(Math.cos(angle)) * box.height;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

export function placeClipboardRoots(
  roots: DesignNode[],
  target: DesignNode[],
  options: {
    parentId: string | null;
    boxes?: MeasuredBoxes;
    inPlace?: boolean;
    position?: Point;
    sourcePosition?: Point;
    viewport?: Box;
    sameFile: boolean;
  },
) {
  const sourceBounds = boundingBox(roots.map((node) => node.box));
  let parentId =
    !options.inPlace &&
    (options.position || options.viewport) &&
    roots.some((node) => node.type === "artboard")
      ? null
      : options.parentId;
  const viewport = options.viewport;
  if (!options.inPlace && !options.position && viewport && parentId) {
    const parent = target.find((node) => node.id === parentId)!;
    const bounds = visualBounds(reparentGeometry(target, parent, null, options.boxes));
    const marginX = viewport.width / 4;
    const marginY = viewport.height / 4;
    if (
      bounds.x + bounds.width < viewport.x - marginX ||
      bounds.y + bounds.height < viewport.y - marginY ||
      bounds.x > viewport.x + viewport.width + marginX ||
      bounds.y > viewport.y + viewport.height + marginY
    )
      parentId = null;
  }

  const toParent = (node: DesignNode, destination: string | null, box = node.box) =>
    reparentGeometry(
      destination === null && node.parentId === null ? [] : target,
      node,
      destination,
      options.boxes,
      box,
    );
  let placed =
    options.inPlace || (!options.position && viewport && parentId)
      ? roots.map((node) => ({
          id: node.id,
          ...toParent(node, node.type === "artboard" ? null : parentId),
        }))
      : [];
  if (!options.inPlace && sourceBounds) {
    if (!options.position && viewport && parentId) {
      const bounds = boundingBox(placed.map((node) => node.box))!;
      const parent = target.find((node) => node.id === parentId)!;
      const parentBox = options.boxes?.get(parent.id) ?? parent.box;
      const border = parent.style.borderWidth ?? 0;
      const width = Math.max(
        0,
        parentBox.width -
          (parent.style.borderLeftWidth ?? border) -
          (parent.style.borderRightWidth ?? border),
      );
      const height = Math.max(
        0,
        parentBox.height -
          (parent.style.borderTopWidth ?? border) -
          (parent.style.borderBottomWidth ?? border),
      );
      const source = options.sourcePosition;
      let position =
        source &&
        source.x >= 0 &&
        source.y >= 0 &&
        source.x + bounds.width <= width &&
        source.y + bounds.height <= height
          ? source
          : { x: (width - bounds.width) / 2, y: (height - bounds.height) / 2 };
      const world = visualBounds(reparentGeometry(target, parent, null, options.boxes));
      if (world.width > viewport.width || world.height > viewport.height) {
        const centerBox = {
          x: viewport.x + viewport.width / 2,
          y: viewport.y + viewport.height / 2,
          width: 0,
          height: 0,
        };
        const center = reparentGeometry(
          target,
          {
            ...roots[0],
            parentId: null,
            style: {},
            box: centerBox,
          },
          parentId,
          options.boxes,
          centerBox,
        ).box;
        position = {
          x: Math.max(0, Math.min(Math.max(0, width - bounds.width), center.x - bounds.width / 2)),
          y: Math.max(
            0,
            Math.min(Math.max(0, height - bounds.height), center.y - bounds.height / 2),
          ),
        };
      }
      placed = placed.map((node) => ({
        ...node,
        box: {
          ...node.box,
          x: node.box.x + position.x - bounds.x,
          y: node.box.y + position.y - bounds.y,
        },
      }));
    } else {
      const offset = {
        x: viewport && !options.sameFile ? 0 : 24,
        y: viewport && !options.sameFile ? 0 : 24,
      };
      if (options.position) {
        offset.x = options.position.x - sourceBounds.x;
        offset.y = options.position.y - sourceBounds.y;
      } else if (
        viewport &&
        (options.parentId !== parentId ||
          sourceBounds.x + offset.x < viewport.x ||
          sourceBounds.y + offset.y < viewport.y ||
          sourceBounds.x + offset.x + sourceBounds.width > viewport.x + viewport.width ||
          sourceBounds.y + offset.y + sourceBounds.height > viewport.y + viewport.height)
      ) {
        offset.x = viewport.x + (viewport.width - sourceBounds.width) / 2 - sourceBounds.x;
        offset.y = viewport.y + (viewport.height - sourceBounds.height) / 2 - sourceBounds.y;
      }
      placed = roots.map((node) => {
        const box = { ...node.box, x: node.box.x + offset.x, y: node.box.y + offset.y };
        return {
          id: node.id,
          ...toParent({ ...node, box }, node.type === "artboard" ? null : parentId),
        };
      });
    }
  }
  const byId = new Map(placed.map(({ id, ...geometry }) => [id, geometry]));
  const bounds = boundingBox(
    roots.map((node) => {
      const geometry = byId.get(node.id)!;
      const world =
        parentId === null || node.type === "artboard"
          ? geometry
          : reparentGeometry(
              target,
              { ...node, ...geometry, parentId },
              null,
              options.boxes,
              geometry.box,
            );
      return visualBounds(world);
    }),
  );
  return { parentId, roots: byId, bounds };
}
