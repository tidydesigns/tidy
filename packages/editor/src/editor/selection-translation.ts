import type { DesignNode } from "../design/document";
import { equalJsonValues } from "../design/json-value";

export function selectionTranslationDelta(before: DesignNode, after: DesignNode) {
  if (
    (after.widthMode && after.widthMode !== "fixed") ||
    (after.heightMode && after.heightMode !== "fixed") ||
    (after.horizontalConstraint && after.horizontalConstraint !== "start") ||
    (after.verticalConstraint && after.verticalConstraint !== "start") ||
    after.responsiveBreakpoints?.length ||
    after.instanceOf ||
    after.variants ||
    after.vectorBoolean ||
    after.mask?.enabled ||
    before.box.width !== after.box.width ||
    before.box.height !== after.box.height ||
    !equalJsonValues(before, { ...after, box: before.box })
  )
    return null;
  return { x: after.box.x - before.box.x, y: after.box.y - before.box.y };
}

export function canReuseSelectionAncestors(nodes: readonly DesignNode[]) {
  return nodes.every(
    (node) =>
      node.layout === "absolute" &&
      node.style.overflow !== "auto" &&
      (!node.horizontalConstraint || node.horizontalConstraint === "start") &&
      (!node.verticalConstraint || node.verticalConstraint === "start") &&
      !node.responsiveBreakpoints?.length &&
      node.widthMode !== "hug" &&
      node.heightMode !== "hug",
  );
}
