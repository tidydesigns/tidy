import type { DesignNode } from "./document";

type SelectionDragTarget = { kind: "layer"; id: string } | { kind: "gap" };

/** Resolve selection ownership before ordinary clicks can select a child or parent. */
export function selectionDragTarget(
  nodes: ReadonlyMap<string, DesignNode>,
  ids: string[],
  hitId: string | null,
): SelectionDragTarget | null {
  if (!ids.length) return null;
  const selected = new Set(ids);
  let hit = nodes.get(hitId ?? "");
  while (hit) {
    if (selected.has(hit.id)) return { kind: "layer", id: hit.id };
    hit = nodes.get(hit.parentId ?? "");
  }
  if (!hitId) return { kind: "gap" };
  // A selected layer's ancestor can expose empty space between selected children.
  // Unrelated layers inside the bounding box retain their ordinary click behavior.
  for (const id of ids) {
    let parent = nodes.get(id)?.parentId;
    while (parent) {
      if (parent === hitId) return { kind: "gap" };
      parent = nodes.get(parent)?.parentId;
    }
  }
  return null;
}
