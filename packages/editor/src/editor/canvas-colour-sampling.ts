import type { DesignNode, DesignPaint } from "../design/document";
import { nodePaints } from "../design/paints";
import { nodeStrokePaints, strokeWidths } from "../design/strokes";
import { normalizeColor } from "../design/selection-colors";

type Point = Pick<DesignNode["box"], "x" | "y">;
export type ColourHit =
  | { kind: "colour"; colour: string }
  | { kind: "transparent" }
  | { kind: "unsupported" };

function paintStackHit(
  paints: readonly DesignPaint[],
  tokens: Readonly<Record<string, string>>,
): ColourHit {
  for (const paint of paints) {
    if (!paint.visible || paint.opacity <= 0) continue;
    if (paint.type !== "solid") return { kind: "unsupported" };
    const colour = normalizeColor(paint.token ? (tokens[paint.token] ?? paint.color) : paint.color);
    if (!colour) return { kind: "unsupported" };
    if (colour.length === 9 && colour.endsWith("00")) continue;
    return { kind: "colour", colour };
  }
  return { kind: "transparent" };
}

export function nodePaintHit({
  node,
  tokens,
  onBorder,
}: {
  node: DesignNode;
  tokens: Readonly<Record<string, string>>;
  onBorder: boolean;
}): ColourHit {
  if (!node.visible || node.style.opacity === 0) return { kind: "transparent" };
  if (onBorder) {
    const stroke = paintStackHit(nodeStrokePaints(node), tokens);
    if (stroke.kind !== "transparent") return stroke;
  }
  return paintStackHit(nodePaints(node), tokens);
}

export function firstCanvasColour(hits: Iterable<ColourHit>): string | undefined {
  for (const hit of hits) {
    switch (hit.kind) {
      case "colour":
        return hit.colour;
      case "transparent":
        continue;
      case "unsupported":
        return;
      default: {
        const _exhaustive: never = hit;
        return _exhaustive;
      }
    }
  }
}

export function pointOnBorder({
  point,
  size,
  widths,
}: {
  point: Point;
  size: Pick<DesignNode["box"], "width" | "height">;
  widths: ReturnType<typeof strokeWidths>;
}) {
  return (
    point.x >= 0 &&
    point.y >= 0 &&
    point.x < size.width &&
    point.y < size.height &&
    (point.y < widths[0] ||
      point.x >= size.width - widths[1] ||
      point.y >= size.height - widths[2] ||
      point.x < widths[3])
  );
}

export function textSampleTransform({
  matrix,
  line,
  metrics,
  point,
}: {
  matrix: Pick<DOMMatrixReadOnly, "a" | "b" | "c" | "d">;
  line: Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">;
  metrics: Pick<TextMetrics, "width" | "fontBoundingBoxAscent" | "fontBoundingBoxDescent">;
  point: Point;
}): [number, number, number, number, number, number] | undefined {
  const height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
  if (
    metrics.width <= 0 ||
    height <= 0 ||
    line.width <= 0 ||
    line.height <= 0 ||
    matrix.a * matrix.d - matrix.b * matrix.c === 0
  )
    return;
  const result: [number, number, number, number, number, number] = [
    matrix.a,
    matrix.b,
    matrix.c,
    matrix.d,
    line.left +
      line.width / 2 -
      Math.floor(point.x) -
      (matrix.a * metrics.width) / 2 -
      (matrix.c * height) / 2,
    line.top +
      line.height / 2 -
      Math.floor(point.y) -
      (matrix.b * metrics.width) / 2 -
      (matrix.d * height) / 2,
  ];
  return result.every(Number.isFinite) ? result : undefined;
}
