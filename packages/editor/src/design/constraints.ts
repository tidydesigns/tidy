import type { DesignNode } from "./document";
import { nodeIndex } from "./node-index";
import { innerSize, constrainAxis } from "@tidy/design-renderer/constraints";

export {
  innerSize,
  constrainAxis,
  storedConstraintBox,
  constraintStyle,
} from "@tidy/design-renderer/constraints";

/** Parent resize changes free children in place, recursively, without creating instance overrides. */
export function applyResizeConstraints(
  before: DesignNode[],
  after: DesignNode[],
  explicitGeometry?: ReadonlySet<string>,
): DesignNode[] {
  const previous = nodeIndex(before);
  // Moving or recoloring a layer cannot change descendant size constraints.
  if (
    !after.some((node) => {
      const old = previous.get(node.id);
      if (old === node || !old) return false;
      const from = innerSize(old),
        to = innerSize(node);
      return from.width !== to.width || from.height !== to.height;
    })
  )
    return after;
  const next = new Map(after.map((node) => [node.id, node]));
  const visited = new Set<string>();
  function resolve(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const node = next.get(id);
    const old = previous.get(id);
    if (!node?.parentId || !old || old.parentId !== node.parentId) return;
    resolve(node.parentId);
    if (explicitGeometry?.has(id)) return;
    const parent = next.get(node.parentId);
    const oldParent = previous.get(node.parentId);
    if (!parent || !oldParent || (parent.layout !== "absolute" && node.positionMode !== "absolute"))
      return;
    const from = innerSize(oldParent);
    const to = innerSize(parent);
    const box = { ...node.box };
    if (
      from.width !== to.width &&
      (!node.widthMode || node.widthMode === "fixed") &&
      node.box.x === old.box.x &&
      node.box.width === old.box.width
    ) {
      const x = constrainAxis(box.x, box.width, from.width, to.width, node.horizontalConstraint);
      box.x = x.position;
      box.width = x.size;
    }
    if (
      from.height !== to.height &&
      (!node.heightMode || node.heightMode === "fixed") &&
      node.box.y === old.box.y &&
      node.box.height === old.box.height
    ) {
      const y = constrainAxis(box.y, box.height, from.height, to.height, node.verticalConstraint);
      box.y = y.position;
      box.height = y.size;
    }
    if (
      box.x !== node.box.x ||
      box.y !== node.box.y ||
      box.width !== node.box.width ||
      box.height !== node.box.height
    )
      next.set(id, { ...node, box });
  }
  for (const node of after) resolve(node.id);
  return after.map((node) => next.get(node.id)!);
}
