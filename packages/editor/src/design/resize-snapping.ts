import { rotatePoint, type ResizeHandle } from "./resize-box";
import { nearestSnapAnchor } from "./snap-index";
import type { SnapBox } from "./snapping";

type Point = { x: number; y: number };
type Matrix = { a: number; b: number; c: number; d: number };
type Options = {
  centered?: boolean;
  aspect?: boolean;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
};

/** Snap the moving handle in screen space, preserving its opposite anchor and constraints.
 * The matrix includes ancestor transforms, node rotation/flips and canvas zoom.
 * Candidates and the initial center are measured once at pointer-down.
 */
export function snapLayerResize(
  original: SnapBox,
  box: SnapBox,
  handle: ResizeHandle,
  center: Point,
  matrix: Matrix,
  candidates: SnapBox[],
  tolerance: number,
  options: Options = {},
): SnapBox {
  const horizontal = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
  const vertical = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
  const project = (x: number, y: number) => ({
    x: matrix.a * x + matrix.c * y,
    y: matrix.b * x + matrix.d * y,
  });
  const shift = options.centered
    ? { x: 0, y: 0 }
    : project(
        (horizontal * (box.width - original.width)) / 2,
        (vertical * (box.height - original.height)) / 2,
      );
  const offset = project((horizontal * box.width) / 2, (vertical * box.height) / 2);
  const point = { x: center.x + shift.x + offset.x, y: center.y + shift.y + offset.y };
  const factor = options.centered ? 0.5 : 1;
  const widthVector = project(horizontal * factor, 0);
  const heightVector = project(0, vertical * factor);
  const anchors = (["x", "y"] as const).flatMap((axis) => {
    const match = nearestSnapAnchor(candidates, axis, point[axis], tolerance);
    return match ? [{ axis, distance: match.distance }] : [];
  });
  if (!anchors.length) return box;

  const possibilities: { width: number; height: number; score: number }[] = [];
  function accept(dw: number, dh: number, snappedAxes: number) {
    const width = box.width + dw,
      height = box.height + dh;
    if (
      ![width, height].every(Number.isFinite) ||
      width < 1 ||
      height < 1 ||
      width > 5000 ||
      height > 5000
    )
      return;
    const movement = Math.hypot(
      widthVector.x * dw + heightVector.x * dh,
      widthVector.y * dw + heightVector.y * dh,
    );
    if (movement > tolerance * Math.sqrt(snappedAxes) + 0.000001) return;
    // Prefer two compatible anchors; otherwise use the least screen movement.
    possibilities.push({ width, height, score: movement - (snappedAxes - 1) * tolerance * 2 });
  }
  if (options.aspect || !horizontal || !vertical) {
    const dw = options.aspect ? box.width : horizontal ? 1 : 0;
    const dh = options.aspect ? box.height : vertical ? 1 : 0;
    const direction = {
      x: widthVector.x * dw + heightVector.x * dh,
      y: widthVector.y * dw + heightVector.y * dh,
    };
    for (const anchor of anchors) {
      if (Math.abs(direction[anchor.axis]) < 0.000001) continue;
      const amount = anchor.distance / direction[anchor.axis];
      accept(dw * amount, dh * amount, 1);
    }
  } else {
    const determinant = widthVector.x * heightVector.y - widthVector.y * heightVector.x;
    if (Math.abs(determinant) < 0.000001) return box;
    const solve = (x: number, y: number, count: number) =>
      accept(
        (x * heightVector.y - y * heightVector.x) / determinant,
        (y * widthVector.x - x * widthVector.y) / determinant,
        count,
      );
    if (anchors.length === 2) solve(anchors[0].distance, anchors[1].distance, 2);
    for (const anchor of anchors)
      solve(
        anchor.axis === "x" ? anchor.distance : 0,
        anchor.axis === "y" ? anchor.distance : 0,
        1,
      );
  }
  const best = possibilities.sort((a, b) => a.score - b.score)[0];
  if (!best) return box;
  const anchorShift = options.centered
    ? { x: 0, y: 0 }
    : rotatePoint(
        {
          x: ((horizontal * (best.width - box.width)) / 2) * (options.flipX ? -1 : 1),
          y: ((vertical * (best.height - box.height)) / 2) * (options.flipY ? -1 : 1),
        },
        options.rotation ?? 0,
      );
  return {
    x: box.x + (box.width - best.width) / 2 + anchorShift.x,
    y: box.y + (box.height - best.height) / 2 + anchorShift.y,
    width: best.width,
    height: best.height,
  };
}
