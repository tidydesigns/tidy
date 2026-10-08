import type { DesignNode } from "./document";

// Documents are immutable; a WeakMap releases the index when a snapshot is retired.
const indexes = new WeakMap<DesignNode[], ReadonlyMap<string, DesignNode>>();
export function nodeIndex(nodes: DesignNode[]): ReadonlyMap<string, DesignNode> {
  let index = indexes.get(nodes);
  if (!index) {
    index = new Map(nodes.map((node) => [node.id, node]));
    indexes.set(nodes, index);
  }
  return index;
}
