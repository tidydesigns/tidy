import { parseDesignDocument, type DesignDocument, type DesignNode } from "./document";
import { type DesignToken, tokenNameSchema } from "./design-tokens";
import { isLayerLocked, isLayerVisible } from "./edit-document";
import { nodePaints, paintStyle } from "./paints";
import { nodeStrokePaints } from "./strokes";
import { normalizeColor } from "./selection-colors";

export const tokenDefaults = {
  color: { type: "color", value: "#ff5d00" },
  radius: { type: "radius", value: 8 },
  spacing: { type: "spacing", value: 8 },
  dimension: { type: "dimension", value: 100 },
  number: { type: "number", value: 1 },
  typography: {
    type: "typography",
    value: {
      fontFamily: "system-ui",
      fontSource: "system",
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 1.35,
      lineHeightMode: "percent",
    },
  },
} satisfies Record<DesignToken["type"], DesignToken>;

export function tokenNameError(document: DesignDocument, name: string, current?: string) {
  if (!tokenNameSchema.safeParse(name).success)
    return "Use a letter first, then letters, numbers, hyphens or underscores (up to 64).";
  if (
    name !== current &&
    (Object.hasOwn(document.tokens, name) || Object.hasOwn(document.designTokens ?? {}, name))
  )
    return "A token with that name already exists.";
}

export function availableTokenName(document: DesignDocument, base: string) {
  let name = base,
    index = 2;
  while (Object.hasOwn(document.tokens, name) || Object.hasOwn(document.designTokens ?? {}, name))
    name = `${base.slice(0, 58)}-${index++}`;
  return name;
}

/** Replace either wire format without changing references to the token's name. */
export function putDesignToken(document: DesignDocument, name: string, token: DesignToken) {
  const tokens = { ...document.tokens };
  delete tokens[name];
  return parseDesignDocument({
    ...document,
    tokens,
    designTokens: { ...document.designTokens, [name]: token },
  });
}

/** Only visit bindable base-layer properties; never replace an existing token link. */
function mapUnboundColors(
  node: DesignNode,
  map: (color: string) => string | undefined,
): DesignNode {
  const binding = (color: string, token?: string) => token || map(color);
  const paints = nodePaints(node).map((paint) => {
    if (!paint.visible || paint.opacity === 0) return paint;
    if (paint.type === "solid") return { ...paint, token: binding(paint.color, paint.token) };
    if (paint.type === "linear" || paint.type === "radial")
      return {
        ...paint,
        stops: paint.stops.map((stop) => ({ ...stop, token: binding(stop.color, stop.token) })),
      };
    return paint;
  });
  const strokes = nodeStrokePaints(node).map((paint) => {
    if (!paint.visible || paint.opacity === 0) return paint;
    if (paint.type === "solid") return { ...paint, token: binding(paint.color, paint.token) };
    return {
      ...paint,
      stops: paint.stops.map((stop) => ({ ...stop, token: binding(stop.color, stop.token) })),
    };
  });
  return {
    ...node,
    style: {
      ...node.style,
      ...(paints.length ? paintStyle(paints) : {}),
      ...(strokes.length ? { strokePaints: strokes } : {}),
      ...(node.type === "text" && node.style.color
        ? { colorToken: binding(node.style.color, node.style.colorToken) }
        : {}),
    },
  };
}

export function unboundPageColors(document: DesignDocument, nodeIds: ReadonlySet<string>) {
  const colors = new Map<string, Set<string>>();
  for (const node of document.nodes) {
    if (
      !nodeIds.has(node.id) ||
      isLayerLocked(document.nodes, node.id) ||
      !isLayerVisible(document.nodes, node.id)
    )
      continue;
    mapUnboundColors(node, (value) => {
      const color = normalizeColor(value);
      if (color) {
        const ids = colors.get(color) ?? new Set<string>();
        ids.add(node.id);
        colors.set(color, ids);
      }
      return undefined;
    });
  }
  return [...colors].map(([color, ids]) => ({ color, count: ids.size }));
}

export function createAndBindColor({
  document,
  nodeIds,
  color,
  name,
}: {
  document: DesignDocument;
  nodeIds: ReadonlySet<string>;
  color: string;
  name: string;
}) {
  const message = tokenNameError(document, name);
  if (message) throw new Error(message);
  if (!normalizeColor(color)) throw new Error("Enter a hex color.");
  const matchingIds = new Set<string>();
  const nodes = document.nodes.map((node) => {
    if (
      !nodeIds.has(node.id) ||
      isLayerLocked(document.nodes, node.id) ||
      !isLayerVisible(document.nodes, node.id)
    )
      return node;
    const next = mapUnboundColors(node, (value) => {
      if (normalizeColor(value) !== normalizeColor(color)) return undefined;
      matchingIds.add(node.id);
      return name;
    });
    return matchingIds.has(node.id) ? next : node;
  });
  // The canvas may have changed since the candidate was shown.
  if (!matchingIds.size) return document;
  return putDesignToken({ ...document, nodes }, name, { type: "color", value: color });
}
