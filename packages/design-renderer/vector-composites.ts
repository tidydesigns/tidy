import type { CSSProperties } from "react";
import type { DesignNode } from "@bella/design/document";
import {
  authoredPathBounds,
  booleanRenderNode,
  nodeAffine,
  pathAffine,
  type Affine,
} from "@bella/design/vector-boolean";
import { effectCss } from "@bella/design/effects";
import { strokeWidths, vectorOutset } from "./strokes";
import { vectorSvg } from "./vector-path";

export { booleanRenderNode };
const transform = (matrix: Affine) => `matrix(${matrix.join(" ")})`;

function childOrigin(node: DesignNode) {
  const [top, , , left] = strokeWidths(node.style);
  return { x: left, y: top };
}

function compositeChildren(nodes: readonly DesignNode[]) {
  const children = new Map<string, DesignNode[]>();
  for (const node of nodes)
    if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  return children;
}
function maskViewport(
  node: DesignNode,
  children: Map<string, DesignNode[]>,
  nodes: readonly DesignNode[],
) {
  const bounds = (
    source: DesignNode,
    depth = 0,
  ): { x: number; y: number; width: number; height: number } => {
    const rendered = booleanRenderNode(source, nodes),
      geometry = authoredPathBounds(rendered);
    const extra = rendered.vectorPath
      ? vectorOutset(rendered) *
        Math.max(
          rendered.box.width / rendered.vectorPath.viewBox.width,
          rendered.box.height / rendered.vectorPath.viewBox.height,
        )
      : 0;
    const boxes = [
      {
        x: -extra,
        y: -extra,
        width: source.box.width + 2 * extra,
        height: source.box.height + 2 * extra,
      },
    ];
    if (geometry)
      boxes.push({
        x: geometry.x - extra,
        y: geometry.y - extra,
        width: geometry.width + 2 * extra,
        height: geometry.height + 2 * extra,
      });
    if (!source.vectorBoolean && depth < 40)
      for (const child of children.get(source.id) ?? []) {
        const box = bounds(child, depth + 1),
          m = nodeAffine(child);
        const origin = childOrigin(source);
        m[4] += origin.x;
        m[5] += origin.y;
        const points = [
          [box.x, box.y],
          [box.x + box.width, box.y],
          [box.x, box.y + box.height],
          [box.x + box.width, box.y + box.height],
        ].map(([x, y]) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }));
        const x = Math.min(...points.map((p) => p.x)),
          y = Math.min(...points.map((p) => p.y));
        boxes.push({
          x,
          y,
          width: Math.max(...points.map((p) => p.x)) - x,
          height: Math.max(...points.map((p) => p.y)) - y,
        });
      }
    const x = Math.min(...boxes.map((b) => b.x)),
      y = Math.min(...boxes.map((b) => b.y));
    return {
      x,
      y,
      width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
      height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
    };
  };
  return bounds(node);
}

/** Self-contained SVG masks use the same path paints and transforms as ordinary vector rendering. */
export function vectorMaskSvg(
  node: DesignNode,
  nodes: readonly DesignNode[],
  tokens: Record<string, string>,
  suppliedViewport?: { x: number; y: number; width: number; height: number },
) {
  let serial = 0;
  const children = compositeChildren(nodes);
  const viewport = suppliedViewport ?? maskViewport(node, children, nodes);
  const paint = (source: DesignNode, depth: number): string => {
    if (depth > 40 || !source.visible) return "";
    const rendered = booleanRenderNode(source, nodes),
      prefix = `s${++serial}-`;
    const filter = effectCss(source.style);
    const attributes = `opacity="${source.style.opacity ?? 1}"${filter ? ` style="filter:${filter}"` : ""}`;
    if (rendered.vectorPath) {
      const inner = vectorSvg(rendered, tokens)
        .replace(/^<svg[^>]*>/, "")
        .replace(/<\/svg>$/, "")
        .replace(/id="([^"]+)"/g, (_m, id: string) => `id="${prefix}${id}"`)
        .replace(/url\(#([^)]*)\)/g, (_m, id: string) => `url(#${prefix}${id})`);
      return `<g transform="${transform(pathAffine(rendered))}" ${attributes}>${inner}</g>`;
    }
    const w = source.box.width,
      h = source.box.height;
    const raw = ["TopLeft", "TopRight", "BottomRight", "BottomLeft"].map(
      (corner) => source.style[`radius${corner}` as "radiusTopLeft"] ?? source.style.radius ?? 0,
    );
    const factor = Math.min(
      1,
      w / (raw[0] + raw[1] || 1),
      w / (raw[2] + raw[3] || 1),
      h / (raw[0] + raw[3] || 1),
      h / (raw[1] + raw[2] || 1),
    );
    const [tl, tr, br, bl] = raw.map((r) => r * factor);
    const curve = (r: number, x: number, y: number) =>
      r ? `A ${r} ${r} 0 0 1 ${x} ${y}` : `L ${x} ${y}`;
    const rectangle: DesignNode = {
      ...source,
      id: `${source.id}-surface`,
      parentId: source.id,
      type: "vector",
      vectorBoolean: undefined,
      mask: undefined,
      box: { x: 0, y: 0, width: w, height: h },
      style: {
        ...source.style,
        rotation: undefined,
        flipX: undefined,
        flipY: undefined,
        opacity: undefined,
        effects: [],
        blur: undefined,
        brightness: undefined,
        contrast: undefined,
        grayscale: undefined,
        saturation: undefined,
        hueRotate: undefined,
      },
      vectorPath: {
        d: `M ${tl} 0 H ${w - tr} ${curve(tr, w, tr)} V ${h - br} ${curve(br, w - br, h)} H ${bl} ${curve(bl, 0, h - bl)} V ${tl} ${curve(tl, tl, 0)} Z`,
        viewBox: { x: 0, y: 0, width: w, height: h },
        fillRule: "nonzero",
      },
    };
    const origin = childOrigin(source);
    const shifted = (body: string) =>
      `<g transform="translate(${origin.x} ${origin.y})">${body}</g>`;
    let body =
      paint(rectangle, depth + 1) +
      shifted(
        (children.get(source.id) ?? [])
          .filter((n) => !source.mask?.enabled || n.id !== source.mask.sourceId)
          .map((n) => paint(n, depth + 1))
          .join(""),
      );
    if (source.mask?.enabled) {
      const mask = children.get(source.id)?.find((n) => n.id === source.mask!.sourceId);
      const id = `${prefix}mask`;
      const region = maskViewport(source, children, nodes);
      body = `<defs><mask id="${id}" mask-type="${source.mask.mode}" maskUnits="userSpaceOnUse" x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}">${mask ? shifted(paint(mask, depth + 1)) : ""}</mask></defs><g mask="url(#${id})">${body}</g>`;
    }
    return `<g transform="${transform(nodeAffine(source))}" ${attributes}>${body}</g>`;
  };
  const source = children.get(node.id)?.find((n) => n.id === node.mask?.sourceId);
  const { x, y, width, height } = viewport;
  const origin = childOrigin(node);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}" preserveAspectRatio="none"><defs><mask id="mask" mask-type="${node.mask?.mode ?? "alpha"}" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${width}" height="${height}">${source ? `<g transform="translate(${origin.x} ${origin.y})">${paint(source, 0)}</g>` : ""}</mask></defs><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="white" mask="url(#mask)"/></svg>`;
}

export function vectorCompositeStyle(
  node: DesignNode,
  nodes: readonly DesignNode[],
  tokens: Record<string, string>,
  containingParent?: DesignNode,
): CSSProperties {
  const parent = containingParent ?? nodes.find((n) => n.id === node.parentId);
  if (parent?.vectorBoolean || (parent?.mask?.enabled && parent.mask.sourceId === node.id))
    return { opacity: 0, pointerEvents: "none" };
  if (!node.mask?.enabled) return {};
  const viewport = maskViewport(node, compositeChildren(nodes), nodes);
  const image = `url("data:image/svg+xml,${encodeURIComponent(vectorMaskSvg(node, nodes, tokens, viewport))}")`;
  return {
    maskImage: image,
    WebkitMaskImage: image,
    maskSize: `${viewport.width}px ${viewport.height}px`,
    WebkitMaskSize: `${viewport.width}px ${viewport.height}px`,
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: `${viewport.x}px ${viewport.y}px`,
    WebkitMaskPosition: `${viewport.x}px ${viewport.y}px`,
    maskMode: "alpha",
    maskOrigin: "border-box",
    maskClip: "no-clip",
  };
}
