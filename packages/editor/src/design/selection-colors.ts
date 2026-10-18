import { nodeStrokePaints } from "./strokes";
import type { DesignNode } from "./document";
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

export function addRecentColor(colors: string[], value: string): string[] {
  const color = normalizeColor(value);
  return color
    ? [color, ...colors.filter((entry) => normalizeColor(entry) !== color)].slice(0, 12)
    : colors;
}
