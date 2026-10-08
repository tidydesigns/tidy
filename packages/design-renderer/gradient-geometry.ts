import type { DesignPaint, DesignNode } from "@bella/design/document";
export type GradientPaint = Extract<DesignPaint, { type: "linear" | "radial" }>;
export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type GradientEdit =
  | { kind: "line"; start: Point; end: Point }
  | {
      kind: "radial";
      centerX?: number;
      centerY?: number;
      radiusX?: number;
      radiusY?: number;
      rotation?: number;
    }
  | { kind: "stop"; stopId: string; position: number };
export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
// Accommodate CSS corner projections at every supported aspect ratio (1–5000px).
const bounded = (point: Point) => ({
  x: clamp(point.x, -5000, 5001),
  y: clamp(point.y, -5000, 5001),
});
export function gradientSize(node: DesignNode): Size {
  const border = node.style.borderWidth ?? 0;
  return {
    width: Math.max(
      0.001,
      node.box.width -
        (node.style.borderLeftWidth ?? border) -
        (node.style.borderRightWidth ?? border),
    ),
    height: Math.max(
      0.001,
      node.box.height -
        (node.style.borderTopWidth ?? border) -
        (node.style.borderBottomWidth ?? border),
    ),
  };
}
const angleOf = (dx: number, dy: number) => ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
/** CSS's centered gradient line reaches the projections of the rectangle's corners. */
export function defaultGradientLine(angle: number, size: Size) {
  const radians = (angle * Math.PI) / 180,
    dx = Math.sin(radians),
    dy = -Math.cos(radians);
  const length = Math.abs(size.width * dx) + Math.abs(size.height * dy);
  return {
    start: {
      x: 0.5 - (dx * length) / (2 * size.width),
      y: 0.5 - (dy * length) / (2 * size.height),
    },
    end: { x: 0.5 + (dx * length) / (2 * size.width), y: 0.5 + (dy * length) / (2 * size.height) },
  };
}
export function linearGradientLine(paint: Extract<GradientPaint, { type: "linear" }>, size: Size) {
  return paint.start && paint.end
    ? { start: paint.start, end: paint.end }
    : defaultGradientLine(paint.angle, size);
}
export function linearGradientAngle(paint: Extract<GradientPaint, { type: "linear" }>, size: Size) {
  return paint.start && paint.end
    ? angleOf(
        (paint.end.x - paint.start.x) * size.width,
        (paint.end.y - paint.start.y) * size.height,
      )
    : paint.angle;
}
/** Translate source stop positions onto the browser's complete CSS gradient line. */
export function linearGradientMapping(
  paint: Extract<GradientPaint, { type: "linear" }>,
  size: Size,
) {
  const { start, end } = linearGradientLine(paint, size),
    dx = (end.x - start.x) * size.width,
    dy = (end.y - start.y) * size.height;
  const length = Math.max(0.000001, Math.hypot(dx, dy)),
    angle = linearGradientAngle(paint, size);
  const ux = dx / length,
    uy = dy / length,
    cssLength = Math.max(0.000001, Math.abs(size.width * ux) + Math.abs(size.height * uy));
  const offset =
    ((start.x - 0.5) * size.width * ux + (start.y - 0.5) * size.height * uy + cssLength / 2) /
    cssLength;
  return { angle, position: (position: number) => offset + (position * length) / cssLength };
}
export function setLinearGradientAngle(
  paint: Extract<GradientPaint, { type: "linear" }>,
  angle: number,
  size: Size,
) {
  if (!paint.start || !paint.end) return { ...paint, angle };
  const center = { x: (paint.start.x + paint.end.x) / 2, y: (paint.start.y + paint.end.y) / 2 },
    radians = (angle * Math.PI) / 180;
  const radius =
    Math.hypot(
      (paint.end.x - paint.start.x) * size.width,
      (paint.end.y - paint.start.y) * size.height,
    ) / 2;
  return {
    ...paint,
    angle,
    start: bounded({
      x: center.x - (Math.sin(radians) * radius) / size.width,
      y: center.y + (Math.cos(radians) * radius) / size.height,
    }),
    end: bounded({
      x: center.x + (Math.sin(radians) * radius) / size.width,
      y: center.y - (Math.cos(radians) * radius) / size.height,
    }),
  };
}
export function moveLinearEndpoint(
  paint: Extract<GradientPaint, { type: "linear" }>,
  endpoint: "start" | "end",
  point: Point,
  size: Size,
  snap = false,
): GradientEdit {
  const line = linearGradientLine(paint, size),
    fixed = line[endpoint === "start" ? "end" : "start"];
  let dx = (point.x - fixed.x) * size.width,
    dy = (point.y - fixed.y) * size.height;
  if (snap) {
    const angle = (Math.round(angleOf(dx, dy) / 15) * 15 * Math.PI) / 180,
      length = Math.hypot(dx, dy);
    dx = Math.sin(angle) * length;
    dy = -Math.cos(angle) * length;
  }
  if (Math.hypot(dx, dy) < 1) {
    const old = line[endpoint];
    dx = (old.x - fixed.x) * size.width;
    dy = (old.y - fixed.y) * size.height;
    const length = Math.max(0.000001, Math.hypot(dx, dy));
    dx /= length;
    dy /= length;
  }
  const next = bounded({ x: fixed.x + dx / size.width, y: fixed.y + dy / size.height });
  if (Math.hypot(next.x - fixed.x, next.y - fixed.y) <= 0.000001) return { kind: "line", ...line };
  return { kind: "line", ...line, [endpoint]: next };
}
export function translateLinearGradient(
  paint: Extract<GradientPaint, { type: "linear" }>,
  delta: Point,
  size: Size,
): GradientEdit {
  const line = linearGradientLine(paint, size);
  const x = clamp(
      delta.x,
      -5000 - Math.min(line.start.x, line.end.x),
      5001 - Math.max(line.start.x, line.end.x),
    ),
    y = clamp(
      delta.y,
      -5000 - Math.min(line.start.y, line.end.y),
      5001 - Math.max(line.start.y, line.end.y),
    );
  return {
    kind: "line",
    start: { x: line.start.x + x, y: line.start.y + y },
    end: { x: line.end.x + x, y: line.end.y + y },
  };
}
/** Radial axes rotate in physical pixels, independently of the layer transform. */
export function radialGradientAxes(paint: Extract<GradientPaint, { type: "radial" }>, size: Size) {
  const angle = ((paint.rotation ?? 0) * Math.PI) / 180,
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  const center = { x: paint.centerX, y: paint.centerY };
  return {
    center,
    radiusX: {
      x: center.x + paint.radiusX * cos,
      y: center.y + ((paint.radiusX * size.width) / size.height) * sin,
    },
    radiusY: {
      x: center.x - ((paint.radiusY * size.height) / size.width) * sin,
      y: center.y + paint.radiusY * cos,
    },
  };
}
export function moveRadialRadius(
  paint: Extract<GradientPaint, { type: "radial" }>,
  axis: "radiusX" | "radiusY",
  point: Point,
  size: Size,
  lockProportions = false,
): GradientEdit {
  const radians = ((paint.rotation ?? 0) * Math.PI) / 180,
    dx = (point.x - paint.centerX) * size.width,
    dy = (point.y - paint.centerY) * size.height;
  const projected =
    axis === "radiusX"
      ? dx * Math.cos(radians) + dy * Math.sin(radians)
      : -dx * Math.sin(radians) + dy * Math.cos(radians);
  const radius = clamp(
    Math.abs(projected) / (axis === "radiusX" ? size.width : size.height),
    0.001,
    3,
  );
  return lockProportions
    ? {
        kind: "radial",
        radiusX: clamp((paint.radiusX * radius) / paint[axis], 0.001, 3),
        radiusY: clamp((paint.radiusY * radius) / paint[axis], 0.001, 3),
      }
    : { kind: "radial", [axis]: radius };
}
export function gradientStopPoint(paint: GradientPaint, position: number, size: Size) {
  if (paint.type === "radial") {
    const { center, radiusX } = radialGradientAxes(paint, size);
    return {
      x: center.x + (radiusX.x - center.x) * position,
      y: center.y + (radiusX.y - center.y) * position,
    };
  }
  const line = linearGradientLine(paint, size);
  return {
    x: line.start.x + (line.end.x - line.start.x) * position,
    y: line.start.y + (line.end.y - line.start.y) * position,
  };
}
export function gradientStopPosition(paint: GradientPaint, point: Point, size: Size) {
  const line =
      paint.type === "radial"
        ? {
            start: radialGradientAxes(paint, size).center,
            end: radialGradientAxes(paint, size).radiusX,
          }
        : linearGradientLine(paint, size),
    dx = (line.end.x - line.start.x) * size.width,
    dy = (line.end.y - line.start.y) * size.height;
  return clamp(
    ((point.x - line.start.x) * size.width * dx + (point.y - line.start.y) * size.height * dy) /
      Math.max(0.000001, dx * dx + dy * dy),
    0,
    1,
  );
}
/** Merge only a gesture's fields so later color/opacity edits survive its preview and commit. */
export function applyGradientEdit(paint: DesignPaint, edit: GradientEdit, size: Size): DesignPaint {
  if (paint.type !== "linear" && paint.type !== "radial") return paint;
  if (edit.kind === "stop")
    return {
      ...paint,
      stops: paint.stops.map((stop) =>
        stop.id === edit.stopId ? { ...stop, position: clamp(edit.position, 0, 1) } : stop,
      ),
    };
  if (edit.kind === "radial") {
    if (paint.type !== "radial") return paint;
    return {
      ...paint,
      ...(edit.rotation !== undefined ? { rotation: clamp(edit.rotation, -360, 360) } : {}),
      centerX: clamp(edit.centerX ?? paint.centerX, -3, 4),
      centerY: clamp(edit.centerY ?? paint.centerY, -3, 4),
      radiusX: clamp(edit.radiusX ?? paint.radiusX, 0.001, 3),
      radiusY: clamp(edit.radiusY ?? paint.radiusY, 0.001, 3),
    };
  }
  return paint.type === "linear"
    ? {
        ...paint,
        start: edit.start,
        end: edit.end,
        angle: angleOf(
          (edit.end.x - edit.start.x) * size.width,
          (edit.end.y - edit.start.y) * size.height,
        ),
      }
    : paint;
}
