import type { DesignNode } from "./document";

/** The active hierarchy level; selection changes it, pointer movement never does. */
export type SelectionScope = { kind: "canvas" } | { kind: "inside"; id: string };

export function selectionScope({
  nodes,
  selectedIds,
  children,
}: {
  nodes: ReadonlyMap<string, DesignNode>;
  selectedIds: readonly string[];
  children: ReadonlyMap<string | null, readonly DesignNode[]>;
}): SelectionScope {
  if (selectedIds.length > 1) {
    const parentId = nodes.get(selectedIds[0])?.parentId;
    return parentId && selectedIds.every((id) => nodes.get(id)?.parentId === parentId)
      ? { kind: "inside", id: parentId }
      : { kind: "canvas" };
  }
  if (!selectedIds.length) return { kind: "canvas" };
  const selected = nodes.get(selectedIds[0]);
  if (!selected) return { kind: "canvas" };
  if (
    (selected.type === "artboard" || selected.type === "container") &&
    Boolean(children.get(selected.id)?.length) &&
    !selected.vectorPath &&
    !selected.vectorBoolean &&
    !selected.mask?.enabled
  )
    return { kind: "inside", id: selected.id };
  return selected.parentId ? { kind: "inside", id: selected.parentId } : { kind: "canvas" };
}

/** Resolve a DOM hit into one child of the current scope, without reading layout. */
export function canvasSelectionTarget({
  hitId,
  nodes,
  scope,
  deep,
  readOnly,
}: {
  hitId: string | null;
  nodes: ReadonlyMap<string, DesignNode>;
  scope: SelectionScope;
  deep: boolean;
  readOnly: boolean;
}): DesignNode | null {
  let current = hitId ? nodes.get(hitId) : undefined;
  if (!current) return null;
  const path: DesignNode[] = [];
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.id) || !current.visible) return null;
    visited.add(current.id);
    path.push(current);
    if (!current.parentId) break;
    current = nodes.get(current.parentId);
    if (!current) return null;
  }
  let index = path.length - 1;
  if (deep) index = 0;
  else if (scope.kind === "inside") {
    const scopeIndex = path.findIndex((node) => node.id === scope.id);
    if (scopeIndex >= 0) index = Math.max(0, scopeIndex - 1);
  }
  // A locked descendant does not stop its unlocked board being selected.
  // A locked target or ancestor still prevents entering or moving that layer.
  if (!readOnly) for (let i = index; i < path.length; i++) if (path[i].locked) return null;
  return path[index];
}

export const HOVER_CHILD_LIMIT = 32;

/** Inspect at most one bounded sibling list; dense containers keep the target outline. */
export function hoverChildren(
  target: DesignNode,
  children: ReadonlyMap<string | null, readonly DesignNode[]>,
): readonly DesignNode[] {
  const nested = children.get(target.id) ?? [];
  if (target.vectorBoolean || target.mask?.enabled || nested.length > HOVER_CHILD_LIMIT) return [];
  return nested.filter((node) => node.visible && !node.locked);
}
