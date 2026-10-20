import { nodeStrokePaints } from "./strokes";
import { paintStyle } from "./paints";
import type { DesignPaint, DesignNode } from "./document";
import { nodePaints } from "./paints";

export function normalizeColor(value: string | undefined): string | undefined {
  return value && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value) ? value.toLowerCase() : undefined;
}

/** Actual colors used by the selected layers, including token-backed paints. */
export function selectionColors(nodes: DesignNode[], tokens: Record<string, string>): string[] {
  const colors = new Set<string>();
  const add = (value: string | undefined) => {
    const color = normalizeColor(value);
    if (color) colors.add(color);
  };
  for (const node of nodes) {
    for (const paint of [...nodePaints(node), ...nodeStrokePaints(node)]) {
      if (!paint.visible) continue;
      if (paint.type === "solid")
        add(paint.token ? (tokens[paint.token] ?? paint.color) : paint.color);
      if (paint.type === "linear" || paint.type === "radial")
        for (const stop of paint.stops)
          add(stop.token ? (tokens[stop.token] ?? stop.color) : stop.color);
    }
    add(
      node.style.colorToken
        ? (tokens[node.style.colorToken] ?? node.style.color)
        : node.style.color,
    );
    add(
      node.style.borderColorToken
        ? (tokens[node.style.borderColorToken] ?? node.style.borderColor)
        : node.style.borderColor,
    );
    add(node.style.outlineColor);
    for (const shadow of node.style.shadows ?? []) if (shadow.visible) add(shadow.color);
  }
  return [...colors];
}

export function replaceSelectionColor({
  node,
  tokens,
  colour,
  next,
}: {
  node: DesignNode;
  tokens: Record<string, string>;
  colour: string;
  next: string;
}): DesignNode {
  const matches = (value: string | undefined, token?: string) =>
    normalizeColor(token ? (tokens[token] ?? value) : value) === colour;
  const replace = (paint: DesignPaint): DesignPaint => {
    if (!paint.visible) return paint;
    if (paint.type === "solid" && matches(paint.color, paint.token))
      return { ...paint, color: next, token: undefined };
    if (paint.type === "linear" || paint.type === "radial") {
      const stops = paint.stops.map((stop) =>
        matches(stop.color, stop.token) ? { ...stop, color: next, token: undefined } : stop,
      );
      if (stops.some((stop, index) => stop !== paint.stops[index])) return { ...paint, stops };
    }
    return paint;
  };
  const fills = nodePaints(node),
    strokes = nodeStrokePaints(node);
  const changedFills = fills.map(replace),
    changedStrokes = strokes.map(replace);
  const style = { ...node.style };
  if (changedFills.some((paint, index) => paint !== fills[index]))
    Object.assign(style, paintStyle(changedFills));
  if (changedStrokes.some((paint, index) => paint !== strokes[index])) {
    style.strokePaints = changedStrokes.filter((paint) => paint.type !== "image");
    style.borderColor = undefined;
    style.borderColorToken = undefined;
  }
  if (matches(style.color, style.colorToken)) {
    style.color = next;
    style.colorToken = undefined;
  }
  if (matches(style.outlineColor)) style.outlineColor = next;
  style.shadows = style.shadows?.map((shadow) =>
    shadow.visible && matches(shadow.color) ? { ...shadow, color: next } : shadow,
  );
  return { ...node, style };
}
