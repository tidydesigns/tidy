import { nativeShapePath } from "@bella/design/native-shapes";
import type { CSSProperties } from "react";
import { booleanPaintBounds } from "@bella/design/vector-boolean";
import type { DesignNode, DesignStrokePaint } from "@bella/design/document";
import { nodePaints } from "./paints";
import { nodeStrokePaints, paintDefinition, vectorOutset } from "./strokes";

export { vectorOutset } from "./strokes";
/** Edited anchors may extend beyond the original viewport without resizing the layer. */
export function vectorViewport(node: DesignNode) {
  const box = node.vectorPath!.viewBox,
    stroke = vectorOutset(node);
  const points =
    node.vectorPath!.contours?.flatMap((contour) =>
      contour.points.flatMap((p) => [p, ...(p.in ? [p.in] : []), ...(p.out ? [p.out] : [])]),
    ) ?? [];
  const geometry = booleanPaintBounds(node) ?? box;
  const left = Math.min(geometry.x, box.x, ...points.map((p) => p.x)) - stroke;
  const top = Math.min(geometry.y, box.y, ...points.map((p) => p.y)) - stroke;
  const right =
    Math.max(geometry.x + geometry.width, box.x + box.width, ...points.map((p) => p.x)) + stroke;
  const bottom =
    Math.max(geometry.y + geometry.height, box.y + box.height, ...points.map((p) => p.y)) + stroke;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
export function vectorImageStyle(node: DesignNode): CSSProperties {
  const box = node.vectorPath!.viewBox,
    viewport = vectorViewport(node);
  return {
    position: "absolute",
    left: `${((viewport.x - box.x) / box.width) * 100}%`,
    top: `${((viewport.y - box.y) / box.height) * 100}%`,
    width: `${(viewport.width / box.width) * 100}%`,
    height: `${(viewport.height / box.height) * 100}%`,
    maxWidth: "none",
    pointerEvents: "none",
  };
}
export function vectorSvg(node: DesignNode, tokens: Record<string, string>) {
  const source = node.vectorPath!;
  const path = source.shape ? nativeShapePath(source.shape, source.viewBox) : source;
  const { x, y, width, height } = path.viewBox,
    viewport = vectorViewport(node),
    strokeWidth = node.style.borderWidth ?? 0;
  const definitions: string[] = [];
  const draw = (paints: DesignStrokePaint[], stroke: boolean) =>
    [...paints]
      .reverse()
      .filter((paint) => paint.visible)
      .map((paint, index) => {
        const id = `${stroke ? "stroke" : "fill"}-${index}`,
          { fill, definition } = paintDefinition(paint, id, { width, height }, tokens, { x, y });
        definitions.push(definition);
        const markers = stroke
          ? (["Start", "End"] as const)
              .map((end) => {
                const kind = node.style[`stroke${end}`];
                if (!kind || kind === "none") return "";
                const markerId = `${id}-${end}`;
                // Use the same paint server as the path; IDs are local to this self-contained SVG image.
                const body =
                  kind === "circle"
                    ? `<circle cx="0" cy="0" r="1.5" fill="${fill}"/>`
                    : kind === "triangle"
                      ? `<path d="M-3 -1.5L0 0L-3 1.5Z" fill="${fill}"/>`
                      : `<path d="M-2.5 -1.5L0 0L-2.5 1.5" fill="none" stroke="${fill}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>`;
                definitions.push(
                  `<marker id="${markerId}" markerUnits="strokeWidth" markerWidth="8" markerHeight="8" viewBox="-4 -4 8 8" refX="0" refY="0" orient="auto-start-reverse" overflow="visible">${body}</marker>`,
                );
                return ` marker-${end.toLowerCase()}="url(#${markerId})"`;
              })
              .join("")
          : "";
        const dash =
          node.style.borderStyle === "dashed"
            ? ` stroke-dasharray="${strokeWidth * 3} ${strokeWidth * 2}"`
            : node.style.borderStyle === "dotted"
              ? ` stroke-dasharray="0 ${strokeWidth * 2}"`
              : "";
        return `<g opacity="${paint.opacity}" style="mix-blend-mode:${paint.blendMode ?? "normal"}"><path d="${path.d}" fill-rule="${path.fillRule}" ${stroke ? `fill="none" stroke="${fill}" stroke-width="${strokeWidth}" stroke-linecap="${node.style.borderStyle === "dotted" ? "round" : (node.style.strokeCap ?? "butt")}" stroke-linejoin="${node.style.strokeJoin ?? "miter"}" stroke-miterlimit="4"${dash}${markers}` : `fill="${fill}"`}/></g>`;
      })
      .join("");
  const fills = draw(
      nodePaints(node).filter((paint) => paint.type !== "image"),
      false,
    ),
    strokes = strokeWidth ? draw(nodeStrokePaints(node), true) : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${viewport.width}" height="${viewport.height}" viewBox="${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}" preserveAspectRatio="none"><defs>${definitions.join("")}</defs><g style="isolation:isolate">${fills}${strokes}</g></svg>`;
}
