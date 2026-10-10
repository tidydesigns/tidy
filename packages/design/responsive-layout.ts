import type { DesignNode } from "./document";
import { detachChangedBindings } from "./design-tokens";

/** Apply every matching frame-width rule from wide to narrow so narrower rules inherit earlier changes. */
export function responsiveNode(node: DesignNode, frameWidth: number): DesignNode {
  const matching = node.responsiveBreakpoints
    ?.filter((breakpoint) => frameWidth <= breakpoint.frameMaxWidth)
    .sort((a, b) => b.frameMaxWidth - a.frameMaxWidth);
  if (!matching?.length) return node;
  let result = node;
  for (const breakpoint of matching) {
    const { id: _id, frameMaxWidth: _frameMaxWidth, ...changes } = breakpoint;
    void _id;
    void _frameMaxWidth;
    // Undefined is the editor's “Inherit” value, including before a JSON round trip.
    result = {
      ...result,
      ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)),
    };
    if (result.tokenBindings) result.tokenBindings = detachChangedBindings(result, changes);
    if (changes.gridColumns !== undefined && changes.gridColumnTracks === undefined)
      result.gridColumnTracks = undefined;
    if (changes.gridRowTracks?.length === 0) result.gridRowTracks = undefined;
    if (changes.padding !== undefined) {
      for (const side of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const) {
        if (changes[side] === undefined) result[side] = undefined;
      }
    }
    if (changes.gap !== undefined) {
      if (changes.columnGap === undefined) result.columnGap = undefined;
      if (changes.rowGap === undefined) result.rowGap = undefined;
    }
  }
  return result;
}

/** Validate every cascade boundary, including values inherited from wider rules. */
export function validateResponsiveLayout(node: DesignNode) {
  const breakpoints = node.responsiveBreakpoints ?? [];
  if (
    new Set(breakpoints.map((rule) => rule.id)).size !== breakpoints.length ||
    new Set(breakpoints.map((rule) => rule.frameMaxWidth)).size !== breakpoints.length
  )
    throw new Error(`Duplicate responsive breakpoint on layer ${node.id}.`);
  for (const width of [Infinity, ...breakpoints.map((rule) => rule.frameMaxWidth)]) {
    const rendered = responsiveNode(node, width);
    const context = Number.isFinite(width) ? ` at frame width ${width}px` : "";
    if (
      rendered.minWidth !== undefined &&
      rendered.maxWidth !== undefined &&
      rendered.minWidth > rendered.maxWidth
    )
      throw new Error(`Layer ${node.id} has conflicting width limits${context}.`);
    if (
      rendered.minHeight !== undefined &&
      rendered.maxHeight !== undefined &&
      rendered.minHeight > rendered.maxHeight
    )
      throw new Error(`Layer ${node.id} has conflicting height limits${context}.`);
  }
}

/** Root artboard width controls all descendant rules, regardless of nesting. */
export function containingFrameWidth(node: DesignNode, nodes: readonly DesignNode[]) {
  if (!node.parentId) return node.box.width;
  let current = node;
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const visited = new Set<string>();
  while (current.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    current = parent;
    if (parent.type === "artboard") break;
  }
  return current.box.width;
}
