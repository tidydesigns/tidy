import type { DesignNode } from "./document";

// Documents are immutable; a WeakMap releases the index when a snapshot is retired.
const indexes = new WeakMap<readonly DesignNode[], ReadonlyMap<string, DesignNode>>();
export function nodeIndex(nodes: readonly DesignNode[]): ReadonlyMap<string, DesignNode> {
  let index = indexes.get(nodes);
  if (!index) {
    index = new Map(nodes.map((node) => [node.id, node]));
    indexes.set(nodes, index);
  }
  return index;
}

const childIndexes = new WeakMap<
  readonly DesignNode[],
  ReadonlyMap<string, readonly DesignNode[]>
>();
export function nodeChildrenIndex(
  nodes: readonly DesignNode[],
): ReadonlyMap<string, readonly DesignNode[]> {
  let index = childIndexes.get(nodes);
  if (!index) {
    const children = new Map<string, DesignNode[]>();
    for (const node of nodes) {
      if (!node.parentId) continue;
      const siblings = children.get(node.parentId);
      if (siblings) siblings.push(node);
      else children.set(node.parentId, [node]);
    }
    index = children;
    childIndexes.set(nodes, index);
  }
  return index;
}
