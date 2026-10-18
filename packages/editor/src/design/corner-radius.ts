import type { DesignNode, DesignNodeChanges } from "./document";
import { baseCorners } from "@tidy/design-renderer/strokes";

export const radiusCorners = [
  { key: "radiusTopLeft", label: "top left", x: 1, y: 1 },
  { key: "radiusTopRight", label: "top right", x: -1, y: 1 },
  { key: "radiusBottomRight", label: "bottom right", x: -1, y: -1 },
  { key: "radiusBottomLeft", label: "bottom left", x: 1, y: -1 },
] as const;
export type RadiusCorner = 0 | 1 | 2 | 3;
export type RadiusSize = { width: number; height: number };
// Midpoint of a circular corner, measured inward from the rectangular bounds.
export const radiusHandleRatio = 1 - Math.SQRT1_2;
export function supportsCornerRadius(node: DesignNode) {
  return !node.vectorPath && ["container", "artboard", "image"].includes(node.type);
}
export function renderedRadii(node: DesignNode, size: RadiusSize) {
  return baseCorners(node.style, size).map((corner) => corner.x);
}
export function radiusHandlePoint(
  size: RadiusSize,
  radius: number,
  corner: RadiusCorner,
  scale: number,
) {
  const inset = 16 / scale + radius * radiusHandleRatio;
  const x = Math.min(inset, size.width / 2 - 14 / scale);
  const y = Math.min(inset, size.height / 2 - 14 / scale);
  const direction = radiusCorners[corner];
  return { x: direction.x === 1 ? x : size.width - x, y: direction.y === 1 ? y : size.height - y };
}

/** Convert a visible radius to a literal edit without rewriting unrelated corners or bindings. */
export function cornerRadiusChanges(
  node: DesignNode,
  size: RadiusSize,
  corner: RadiusCorner,
  desired: number,
  independent: boolean,
): DesignNodeChanges {
  const max = Math.min(5000, Math.min(size.width, size.height) / 2);
  if (!independent)
    return {
      style: {
        radius: Math.max(0, Math.min(max, desired)),
        radiusTopLeft: undefined,
        radiusTopRight: undefined,
        radiusBottomRight: undefined,
        radiusBottomLeft: undefined,
      },
    };
  const values = radiusCorners.map((c) => node.style[c.key] ?? node.style.radius ?? 0);
  const horizontal = values[corner ^ 1];
  const vertical = values[3 - corner];
  const oppositeHorizontal = values[3 - corner] + values[(corner + 2) % 4];
  const oppositeVertical = values[corner ^ 1] + values[(corner + 2) % 4];
  const limitStyle = { ...node.style, [radiusCorners[corner].key]: 5000 };
  const limit = baseCorners(limitStyle, size)[corner].x;
  const radius = Math.max(0, Math.min(limit, desired));
  // Invert CSS's proportional overlap reduction, including oversized imported radii.
  const literal = Math.max(
    radius,
    (radius * oppositeHorizontal) / size.width,
    (radius * oppositeVertical) / size.height,
    horizontal ? (radius * horizontal) / (size.width - radius) : 0,
    vertical ? (radius * vertical) / (size.height - radius) : 0,
  );
  return { style: { [radiusCorners[corner].key]: Math.min(5000, literal) } };
}
