import type { DesignNode } from "./document";

export const resizeHandles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type ResizeHandle = (typeof resizeHandles)[number];
type Point = { x: number; y: number };
export function rotatePoint(point: Point, degrees: number): Point {
  const angle = (degrees * Math.PI) / 180;
  return {
    x: point.x * Math.cos(angle) - point.y * Math.sin(angle),
    y: point.x * Math.sin(angle) + point.y * Math.cos(angle),
  };
}

/** Keep the opposite edge/corner fixed, including when the layer is rotated. */
export function resizeBox(
  box: DesignNode["box"],
  handle: ResizeHandle,
  delta: Point,
  options: {
    rotation?: number;
    centered?: boolean;
    aspect?: boolean;
    snap?: boolean;
    flipX?: boolean;
    flipY?: boolean;
  } = {},
): DesignNode["box"] {
  const horizontal = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
  const vertical = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
  const local = rotatePoint(delta, -(options.rotation ?? 0));
  if (options.flipX) local.x *= -1;
  if (options.flipY) local.y *= -1;
  const factor = options.centered ? 2 : 1;
  let width = box.width + horizontal * local.x * factor;
  let height = box.height + vertical * local.y * factor;
  if (options.aspect) {
    let scale = !horizontal
      ? height / box.height
      : !vertical
        ? width / box.width
        : Math.abs(width / box.width - 1) >= Math.abs(height / box.height - 1)
          ? width / box.width
          : height / box.height;
    scale = Math.max(
      1 / Math.min(box.width, box.height),
      Math.min(5000 / Math.max(box.width, box.height), scale),
    );
    // Snap one axis only so the exact aspect ratio survives.
    if (options.snap)
      scale = Math.max(
        1 / Math.min(box.width, box.height),
        Math.min(5000 / Math.max(box.width, box.height), Math.round(box.width * scale) / box.width),
      );
    width = box.width * scale;
    height = box.height * scale;
  } else {
    width = Math.max(1, Math.min(5000, options.snap ? Math.round(width) : width));
    height = Math.max(1, Math.min(5000, options.snap ? Math.round(height) : height));
  }
  const shift = options.centered
    ? { x: 0, y: 0 }
    : rotatePoint(
        {
          x: ((horizontal * (width - box.width)) / 2) * (options.flipX ? -1 : 1),
          y: ((vertical * (height - box.height)) / 2) * (options.flipY ? -1 : 1),
        },
        options.rotation ?? 0,
      );
  return {
    x: box.x + box.width / 2 + shift.x - width / 2,
    y: box.y + box.height / 2 + shift.y - height / 2,
    width,
    height,
  };
}

export function rotationFromPointer(
  start: number,
  startAngle: number,
  pointerAngle: number,
  snap = false,
) {
  const delta = ((pointerAngle - startAngle + 540) % 360) - 180;
  const angle = start + delta;
  const rounded = snap ? Math.round(angle / 15) * 15 : Math.round(angle * 10) / 10;
  return ((rounded + 540) % 360) - 180;
}
