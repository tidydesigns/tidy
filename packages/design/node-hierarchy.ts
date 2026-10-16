import type { DesignNode } from "./document";

export function childrenByParent(nodes: readonly DesignNode[]) {
  const children = new Map<string, DesignNode[]>();
  for (const node of nodes)
    if (node.parentId) {
      const siblings = children.get(node.parentId);
      if (siblings) siblings.push(node);
      else children.set(node.parentId, [node]);
    }
  return children;
}
