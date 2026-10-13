import type { DesignNode } from "./document";

export function vectorOperand(node: DesignNode): boolean {
  return Boolean(node.vectorPath || node.vectorBoolean);
}
type ChildrenOf = (id: string) => readonly DesignNode[];

/** Both public APIs share the same eligibility rules; only child lookup differs. */
function maskSource(
  node: DesignNode,
  childrenOf: ChildrenOf,
  results?: WeakMap<DesignNode, boolean>,
): boolean {
  const known = results?.get(node);
  if (known !== undefined) return known;
  let result: boolean;
  if (vectorOperand(node)) result = true;
  else if (node.type !== "container" || node.layout !== "absolute") result = false;
  else if (node.style.paints?.some((paint) => paint.type === "image")) result = false;
  else {
    const children = childrenOf(node.id);
    const painted = Boolean(
      node.style.fill ||
      node.style.fillToken ||
      node.style.gradientFrom ||
      node.style.paints?.some((paint) => paint.visible) ||
      node.style.borderWidth,
    );
    result =
      (painted || children.length > 0) &&
      children.every((child) => maskSource(child, childrenOf, results));
  }
  results?.set(node, result);
  return result;
}

/** A single, untransformed image surface can be used directly as a CSS mask.
 * Restrict this to cases whose image fit and opacity can be represented exactly. */
export function imageMaskPaint(node: DesignNode, nodes: readonly DesignNode[]) {
  const paints = node.style.paints?.filter((paint) => paint.visible);
  const paint = paints?.[0];
  if (
    node.type !== "container" ||
    paints?.length !== 1 ||
    paint?.type !== "image" ||
    !paint.assetId ||
    (paint.fit !== "fill" && !paint.intrinsicSize) ||
    paint.crop ||
    paint.adjustments ||
    nodes.some((child) => child.parentId === node.id) ||
    node.style.rotation ||
    node.style.flipX ||
    node.style.flipY ||
    node.style.radius ||
    node.style.radiusTopLeft ||
    node.style.radiusTopRight ||
    node.style.radiusBottomLeft ||
    node.style.radiusBottomRight ||
    node.style.borderWidth ||
    node.style.blur ||
    node.style.backdropBlur ||
    node.style.shadows?.length ||
    node.style.effects?.length ||
    node.style.brightness ||
    node.style.contrast ||
    node.style.grayscale ||
    node.style.saturation ||
    node.style.hueRotate ||
    (paint.blendMode && paint.blendMode !== "normal")
  )
    return undefined;
  return paint;
}
export function vectorMaskSource(node: DesignNode, nodes: readonly DesignNode[]): boolean {
  return maskSource(node, (id) => nodes.filter((child) => child.parentId === id));
}

/** Preserve candidate order and rendered styles; share hierarchy work within this batch only. */
export function vectorMaskSources(
  candidates: readonly DesignNode[],
  nodes: readonly DesignNode[],
): DesignNode[] {
  let children: Map<string | null, DesignNode[]> | undefined;
  const childrenOf: ChildrenOf = (id) => {
    // Vectors, text and other immediately decidable candidates need no scene index.
    if (!children) {
      children = new Map();
      for (const node of nodes) {
        const siblings = children.get(node.parentId);
        if (siblings) siblings.push(node);
        else children.set(node.parentId, [node]);
      }
    }
    return children.get(id) ?? [];
  };
  const results = new WeakMap<DesignNode, boolean>();
  return candidates.filter((node) => maskSource(node, childrenOf, results));
}
export function validateVectorRelationships(nodes: DesignNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    if (
      (node.vectorBoolean || node.mask) &&
      [node.widthMode, node.heightMode].some((mode) => mode === "fill" || mode === "hug")
    )
      throw new Error("Boolean and mask groups require fixed sizing.");
    if (
      node.vectorBoolean &&
      (node.type !== "container" || node.layout !== "absolute" || node.mask)
    )
      throw new Error("Boolean operations require an absolute container without a mask.");
    if (node.vectorBoolean) {
      const children = nodes.filter((n) => n.parentId === node.id);
      if (
        children.length > 32 ||
        children.some(
          (n) =>
            !vectorOperand(n) ||
            n.positionMode !== "absolute" ||
            n.widthMode === "fill" ||
            n.widthMode === "hug" ||
            n.heightMode === "fill" ||
            n.heightMode === "hug",
        )
      )
        throw new Error(
          "Boolean operands must be at most 32 fixed-size, absolute vector paths or boolean groups.",
        );
    }
    if (node.mask) {
      const source = byId.get(node.mask.sourceId);
      if (
        node.type !== "container" ||
        node.layout !== "absolute" ||
        !source ||
        source.parentId !== node.id ||
        (!vectorMaskSource(source, nodes) && !imageMaskPaint(source, nodes))
      )
        throw new Error("Masks require an absolute container and a supported source child.");
    }
  }
}
