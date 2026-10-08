import type { CSSProperties } from "react";
import type { DesignNode, DesignStrokePaint } from "@bella/design/document";
import { linearGradientLine } from "./gradient-geometry";
type Style = DesignNode["style"];
type Size = { width: number; height: number };
type Corner = { x: number; y: number };
type Corners = [Corner, Corner, Corner, Corner];
export function strokeWidths(style: Style) {
  const width = style.borderWidth ?? 0;
  return [
    style.borderTopWidth ?? width,
    style.borderRightWidth ?? width,
    style.borderBottomWidth ?? width,
    style.borderLeftWidth ?? width,
  ] as const;
}
export function nodeStrokePaints(node: DesignNode): DesignStrokePaint[] {
  return (
    node.style.strokePaints ??
    (strokeWidths(node.style).some((width) => width > 0)
      ? [
          {
            id: "legacy-stroke",
            type: "solid",
            color: node.style.borderColor ?? "#000000",
            token: node.style.borderColorToken,
            opacity: 1,
            visible: true,
          },
        ]
      : [])
  );
}
/** Widths are in SVG viewBox units, so resizing a vector scales its complete appearance. */
export function vectorOutset(node: DesignNode) {
  const width = node.style.borderWidth ?? 0;
  const marker = [node.style.strokeStart, node.style.strokeEnd].some(
    (value) => value && value !== "none",
  );
  return nodeStrokePaints(node).some((paint) => paint.visible && paint.opacity > 0)
    ? width *
        (marker
          ? 4
          : node.style.strokeJoin === "round" || node.style.strokeJoin === "bevel"
            ? 1
            : 2)
    : 0;
}
export function strokeOutsets(node: DesignNode) {
  if (node.vectorPath) {
    const outset = vectorOutset(node),
      box = node.vectorPath.viewBox;
    return [
      (outset * node.box.height) / box.height,
      (outset * node.box.width) / box.width,
      (outset * node.box.height) / box.height,
      (outset * node.box.width) / box.width,
    ];
  }
  const fraction =
    node.style.strokePosition === "outside" ? 1 : node.style.strokePosition === "center" ? 0.5 : 0;
  return strokeWidths(node.style).map((width) =>
    nodeStrokePaints(node).some((paint) => paint.visible && paint.opacity > 0)
      ? width * fraction
      : 0,
  );
}
export function customStroke(style: Style) {
  return (
    style.strokePaints !== undefined ||
    Boolean(style.strokePosition && style.strokePosition !== "inside") ||
    Boolean(style.cornerSmoothing)
  );
}
const rounded = (value: number) => Math.round(value * 1000000) / 1000000;
function normalizeCorners(corners: Corners, width: number, height: number): Corners {
  const ratio = Math.min(
    1,
    ...[
      width / (corners[0].x + corners[1].x || Infinity),
      width / (corners[3].x + corners[2].x || Infinity),
      height / (corners[0].y + corners[3].y || Infinity),
      height / (corners[1].y + corners[2].y || Infinity),
    ].filter((ratio) => ratio > 0),
  );
  return corners.map((corner) => ({ x: corner.x * ratio, y: corner.y * ratio })) as Corners;
}
/** Same superellipse exponent as CSS corner-shape; sampling stays below a pixel at document limits. */
export function cornerPath(
  x: number,
  y: number,
  width: number,
  height: number,
  input: Corners,
  smoothing = 0,
): string {
  if (width <= 0 || height <= 0) return "";
  const corners = normalizeCorners(input, width, height),
    exponent = 2 / 2 ** (1 + smoothing);
  const centers = [
    { x: x + corners[0].x, y: y + corners[0].y },
    { x: x + width - corners[1].x, y: y + corners[1].y },
    { x: x + width - corners[2].x, y: y + height - corners[2].y },
    { x: x + corners[3].x, y: y + height - corners[3].y },
  ];
  let path = "";
  for (const index of [0, 1, 2, 3]) {
    const corner = corners[index],
      center = centers[index];
    const startAngle = Math.PI + (index * Math.PI) / 2;
    const point = (angle: number) => ({
      x: center.x + Math.sign(Math.cos(angle)) * Math.abs(Math.cos(angle)) ** exponent * corner.x,
      y: center.y + Math.sign(Math.sin(angle)) * Math.abs(Math.sin(angle)) ** exponent * corner.y,
    });
    const start = point(startAngle),
      end = point(startAngle + Math.PI / 2);
    path += `${index === 0 ? "M" : "L"}${rounded(start.x)} ${rounded(start.y)}`;
    if (!corner.x || !corner.y) path += `L${rounded(end.x)} ${rounded(end.y)}`;
    else if (!smoothing)
      path += `A${rounded(corner.x)} ${rounded(corner.y)} 0 0 1 ${rounded(end.x)} ${rounded(end.y)}`;
    else {
      const steps = Math.max(12, Math.ceil(Math.sqrt(Math.max(corner.x, corner.y)) * 4));
      for (let step = 1; step <= steps; step++) {
        const next = point(startAngle + ((Math.PI / 2) * step) / steps);
        path += `L${rounded(next.x)} ${rounded(next.y)}`;
      }
    }
  }
  return `${path}Z`;
}
function baseCorners(style: Style, size: Size): Corners {
  const radius = style.radius ?? 0;
  return normalizeCorners(
    [
      style.radiusTopLeft ?? radius,
      style.radiusTopRight ?? radius,
      style.radiusBottomRight ?? radius,
      style.radiusBottomLeft ?? radius,
    ].map((r) => ({ x: r, y: r })) as Corners,
    size.width,
    size.height,
  );
}
function expandedCorners(corners: Corners, offsets: readonly number[]): Corners {
  return corners.map((corner, index) => ({
    x: corner.x ? Math.max(0, corner.x + offsets[index === 0 || index === 3 ? 3 : 1]) : 0,
    y: corner.y ? Math.max(0, corner.y + offsets[index < 2 ? 0 : 2]) : 0,
  })) as Corners;
}
export function strokeGeometry(style: Style, size: Size) {
  const widths = strokeWidths(style),
    fraction = style.strokePosition === "outside" ? 1 : style.strokePosition === "center" ? 0.5 : 0;
  const outset = widths.map((width) => width * fraction),
    inset = widths.map((width) => width * (1 - fraction));
  const radii = baseCorners(style, size);
  const pathAt = (offsets: readonly number[]) =>
    cornerPath(
      -offsets[3],
      -offsets[0],
      size.width + offsets[3] + offsets[1],
      size.height + offsets[0] + offsets[2],
      expandedCorners(radii, offsets),
      style.cornerSmoothing,
    );
  const outer = pathAt(outset),
    inner = pathAt(inset.map((width) => -width));
  const center = pathAt(widths.map((width) => width * (fraction - 0.5)));
  return {
    widths,
    outset,
    inset,
    outer,
    inner,
    center,
    width: size.width + outset[3] + outset[1],
    height: size.height + outset[0] + outset[2],
  };
}
export function paintDefinition(
  paint: DesignStrokePaint,
  id: string,
  size: Size,
  tokens: Record<string, string>,
  origin = { x: 0, y: 0 },
) {
  if (paint.type === "solid")
    return {
      definition: "",
      fill: paint.token ? (tokens[paint.token] ?? paint.color) : paint.color,
    };
  const stops = [...paint.stops]
    .sort((a, b) => a.position - b.position)
    .map(
      (stop) =>
        `<stop offset="${stop.position}" stop-color="${stop.token ? (tokens[stop.token] ?? stop.color) : stop.color}"/>`,
    )
    .join("");
  if (paint.type === "linear") {
    const { start, end } = linearGradientLine(paint, size);
    return {
      fill: `url(#${id})`,
      definition: `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${origin.x + start.x * size.width}" y1="${origin.y + start.y * size.height}" x2="${origin.x + end.x * size.width}" y2="${origin.y + end.y * size.height}">${stops}</linearGradient>`,
    };
  }
  return {
    fill: `url(#${id})`,
    definition: `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${origin.x + paint.centerX * size.width} ${origin.y + paint.centerY * size.height}) scale(${paint.radiusX * size.width} ${paint.radiusY * size.height})">${stops}</radialGradient>`,
  };
}
/** Self-contained border image: outside paint remains visible even on overflow-clipped frames. */
export function strokeSvg(node: DesignNode, tokens: Record<string, string>, size: Size = node.box) {
  const geometry = strokeGeometry(node.style, size),
    { outset, widths, inset } = geometry;
  const paints = nodeStrokePaints(node).filter((paint) => paint.visible);
  const definitions: string[] = [
    `<clipPath id="ring"><path d="${geometry.outer}${geometry.inner}" clip-rule="evenodd"/></clipPath>`,
  ];
  const vertices = [
    [-outset[3], -outset[0]],
    [size.width + outset[1], -outset[0]],
    [size.width + outset[1], size.height + outset[2]],
    [-outset[3], size.height + outset[2]],
  ];
  const inner = [
    [inset[3], inset[0]],
    [size.width - inset[1], inset[0]],
    [size.width - inset[1], size.height - inset[2]],
    [inset[3], size.height - inset[2]],
  ];
  for (let side = 0; side < 4; side++) {
    const next = (side + 1) % 4;
    definitions.push(
      `<clipPath id="side-${side}"><polygon points="${[vertices[side], vertices[next], inner[next], inner[side]].map((point) => point.join(",")).join(" ")}"/></clipPath>`,
    );
  }
  const layers = [...paints]
    .reverse()
    .map((paint, index) => {
      const { definition, fill } = paintDefinition(paint, `paint-${index}`, size, tokens);
      definitions.push(definition);
      const body =
        !node.style.borderStyle || node.style.borderStyle === "solid"
          ? `<path d="${geometry.outer}${geometry.inner}" fill="${fill}" fill-rule="evenodd"/>`
          : `<g clip-path="url(#ring)">${widths.map((width, side) => (width ? `<path d="${geometry.center}" clip-path="url(#side-${side})" fill="none" stroke="${fill}" stroke-width="${width}" stroke-linecap="${node.style.borderStyle === "dotted" ? "round" : "butt"}" stroke-dasharray="${node.style.borderStyle === "dotted" ? `0 ${width * 2}` : `${width * 3} ${width * 2}`}"/>` : "")).join("")}</g>`;
      return `<g opacity="${paint.opacity}" style="mix-blend-mode:${paint.blendMode ?? "normal"}">${body}</g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${geometry.width}" height="${geometry.height}" viewBox="${-outset[3]} ${-outset[0]} ${geometry.width} ${geometry.height}"><defs>${definitions.join("")}</defs><g style="isolation:isolate">${layers}</g></svg>`;
}
export function strokeStyle(
  node: DesignNode,
  tokens: Record<string, string>,
  size: Size = node.box,
): CSSProperties {
  if (!customStroke(node.style))
    return {
      borderImageSource: undefined,
      borderImageSlice: undefined,
      borderImageWidth: undefined,
      borderImageOutset: undefined,
      ...({ cornerShape: undefined } as CSSProperties),
    };
  const { outset } = strokeGeometry(node.style, size);
  return {
    borderColor: "transparent",
    borderImageSource: `url("data:image/svg+xml,${encodeURIComponent(strokeSvg(node, tokens, size))}")`,
    borderImageSlice: "0 fill",
    borderImageWidth: 0,
    borderImageOutset: outset.map((value) => `${value}px`).join(" "),
    ...({
      cornerShape: node.style.cornerSmoothing
        ? `superellipse(${1 + node.style.cornerSmoothing})`
        : undefined,
    } as CSSProperties),
  };
}
