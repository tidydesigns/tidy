import type { DesignNode } from "../design/document";
import { isFixedClippedArtboard } from "../design/canvas-culling";
import { nodeIndex } from "../design/node-index";

export function createCanvasRootCache(maxHiddenNodes = 4000) {
  let previousNodes: readonly DesignNode[] | undefined;
  let counts = new Map<string, number>();
  const recent = new Map<string, true>();
  let result: ReadonlySet<string> = new Set();
  return ({
    nodes,
    visibleRootIds,
  }: {
    nodes: readonly DesignNode[];
    visibleRootIds: ReadonlySet<string>;
  }): ReadonlySet<string> => {
    if (nodes !== previousNodes) {
      previousNodes = nodes;
      counts = new Map();
      const byId = nodeIndex(nodes);
      const eligible = new Set(
        nodes.filter((node) => node.visible && isFixedClippedArtboard(node)).map((node) => node.id),
      );
      const roots = new Map<string, string>();
      for (const node of nodes) {
        let current = node;
        const path: string[] = [];
        while (current.parentId && !roots.has(current.id)) {
          path.push(current.id);
          const parent = byId.get(current.parentId);
          if (!parent) break;
          current = parent;
        }
        const root = roots.get(current.id) ?? current.id;
        roots.set(node.id, root);
        for (const id of path) roots.set(id, root);
        if (eligible.has(root)) counts.set(root, (counts.get(root) ?? 0) + 1);
      }
      for (const id of recent.keys()) if (!counts.has(id)) recent.delete(id);
    }
    for (const id of visibleRootIds) {
      if (!counts.has(id)) continue;
      recent.delete(id);
      recent.set(id, true);
    }
    const next = new Set(visibleRootIds);
    let hiddenNodes = 0;
    for (const id of [...recent.keys()].reverse()) {
      if (visibleRootIds.has(id)) continue;
      const count = counts.get(id) ?? 0;
      if (hiddenNodes + count > maxHiddenNodes) {
        recent.delete(id);
        continue;
      }
      hiddenNodes += count;
      next.add(id);
    }
    if (result.size !== next.size || [...next].some((id) => !result.has(id))) result = next;
    return result;
  };
}
