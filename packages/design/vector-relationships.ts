import type { DesignNode } from "./document";

export function vectorOperand(node: DesignNode): boolean {
  return Boolean(node.vectorPath || node.vectorBoolean);
}
/** Build a hierarchy index for one evaluation batch; never cache mutable caller arrays. */
function maskSourceSelector(nodes: readonly DesignNode[]) {
  const children = new Map<string | null, DesignNode[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node);
    else children.set(node.parentId, [node]);
  }
  const results = new WeakMap<DesignNode, boolean>();
  function eligible(node: DesignNode): boolean {
    const known = results.get(node);
    if (known !== undefined) return known;
    if (vectorOperand(node)) return true;
    if (node.type !== "container" || node.layout !== "absolute") return false;
    if (node.style.paints?.some((p) => p.type === "image")) return false;
    const descendants = children.get(node.id) ?? [];
    const painted = Boolean(
      node.style.fill ||
      node.style.fillToken ||
      node.style.gradientFrom ||
      node.style.paints?.some((p) => p.visible) ||
      node.style.borderWidth,
    );
    const result = (painted || descendants.length > 0) && descendants.every(eligible);
    results.set(node, result);
    return result;
  }
  return eligible;
}
export function vectorMaskSource(node: DesignNode, nodes: readonly DesignNode[]): boolean {
  if (vectorOperand(node)) return true;
  if (node.type !== "container" || node.layout !== "absolute") return false;
  if (node.style.paints?.some((p) => p.type === "image")) return false;
  const children = nodes.filter((n) => n.parentId === node.id);
  const painted = Boolean(
    node.style.fill ||
    node.style.fillToken ||
    node.style.gradientFrom ||
    node.style.paints?.some((p) => p.visible) ||
    node.style.borderWidth,
  );
  return (painted || children.length > 0) && children.every((n) => vectorMaskSource(n, nodes));
}
/** Preserve candidate order and rendered styles while sharing descendant traversal. */
export function vectorMaskSources(
  candidates: readonly DesignNode[],
  nodes: readonly DesignNode[],
): DesignNode[] {
  return candidates.filter(maskSourceSelector(nodes));
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
        !vectorMaskSource(source, nodes)
      )
        throw new Error("Masks require an absolute container and a vector source child.");
    }
  }
}
