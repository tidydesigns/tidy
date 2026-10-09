import {
  designNodeSchema,
  parseDesignDocument,
  type DesignDocument,
  type DesignNode,
  type DesignNodeChanges,
} from "./document";
import { reconcileComponentStructure } from "./component-structure";
import { syncComponentEdit } from "./component-sync";
import { duplicateNodeTree } from "./duplicate-node";
import { rotatePoint } from "./resize-box";
import { innerSize } from "./constraints";
import { equalJsonValues } from "./json-value";
import { nodeIndex } from "./node-index";
import { resolveNodeTokens } from "./design-tokens";

export function isLayerLocked(nodes: DesignNode[], id: string): boolean {
  const byId = nodeIndex(nodes);
  let node = byId.get(id);
  while (node) {
    if (node.locked || node.librarySource) return true;
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return false;
}

export function isLayerVisible(nodes: DesignNode[], id: string): boolean {
  const byId = nodeIndex(nodes);
  let node = byId.get(id);
  while (node) {
    if (!node.visible) return false;
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return true;
}

export function selectionRoots(nodes: DesignNode[], ids: string[]): DesignNode[] {
  const selected = new Set(ids);
  const byId = nodeIndex(nodes);
  return nodes
    .filter((node) => selected.has(node.id) && !isLayerLocked(nodes, node.id))
    .filter((node) => {
      let parent = node.parentId;
      while (parent) {
        if (selected.has(parent)) return false;
        parent = byId.get(parent)?.parentId ?? null;
      }
      return true;
    });
}

/** The same movable roots drive gesture setup, previews and canonical moves. */
export function movableSelectionRoots(nodes: DesignNode[], ids: string[]): DesignNode[] {
  const byId = nodeIndex(nodes);
  return selectionRoots(nodes, ids).filter((node) => {
    const parent = byId.get(node.parentId ?? "");
    return !parent || parent.layout === "absolute" || node.positionMode === "absolute";
  });
}

/** Prepare nodes for a transaction. Callers must validate the document before publishing it. */
export function changedLayers(
  document: DesignDocument,
  ids: string[],
  changes: DesignNodeChanges | ((node: DesignNode) => DesignNodeChanges),
): DesignNode[] {
  let nodes = document.nodes;
  for (const id of ids) {
    const node = nodeIndex(nodes).get(id);
    if (!node) continue;
    const resolved = resolveNodeTokens(node, document);
    const patch = typeof changes === "function" ? changes(resolved) : changes;
    if (isLayerLocked(nodes, id) && !(patch.locked === false && Object.keys(patch).length === 1))
      continue;
    nodes = syncComponentEdit(nodes, id, patch, document);
  }
  return nodes;
}

export function editLayers(
  document: DesignDocument,
  ids: string[],
  changes: DesignNodeChanges | ((node: DesignNode) => DesignNodeChanges),
): DesignDocument {
  return parseDesignDocument({ ...document, nodes: changedLayers(document, ids, changes) });
}

/** Local gesture only: structural edits are excluded; canonical commits still fully validate. */
export function previewLayerChanges(
  document: DesignDocument,
  ids: string[],
  changes: Pick<DesignNodeChanges, "box" | "style" | "widthMode" | "heightMode" | "vectorPath">,
): DesignDocument {
  if (
    Object.keys(changes).some(
      (key) => !["box", "style", "widthMode", "heightMode", "vectorPath"].includes(key),
    )
  )
    throw new Error("Invalid gesture preview.");
  const old = nodeIndex(document.nodes);
  const nodes = changedLayers(document, ids, changes).map((node) =>
    old.get(node.id) === node ? node : designNodeSchema.parse(node),
  );
  return { ...document, nodes };
}

/** Prepare a move for a transaction; preserves lock, component and constraint semantics. */
export function movedLayers(
  document: DesignDocument,
  ids: string[],
  x: number,
  y: number,
  renderedParents?: ReadonlyMap<string, { width: number; height: number }>,
): DesignNode[] {
  const byId = nodeIndex(document.nodes);
  const roots = movableSelectionRoots(document.nodes, ids);
  const changes = (node: DesignNode): DesignNodeChanges => {
    const ancestors: DesignNode[] = [];
    let parent = byId.get(node.parentId ?? "");
    while (parent) {
      ancestors.push(parent);
      parent = byId.get(parent.parentId ?? "");
    }
    let delta = { x, y };
    for (const ancestor of ancestors.reverse()) {
      delta = rotatePoint(delta, -(ancestor.style.rotation ?? 0));
      if (ancestor.style.flipX) delta.x *= -1;
      if (ancestor.style.flipY) delta.y *= -1;
    }
    const constraintParent = byId.get(node.parentId ?? "");
    const actual = renderedParents?.get(node.id);
    if (constraintParent && actual) {
      const reference = innerSize(constraintParent);
      if (node.horizontalConstraint === "scale" && (!node.widthMode || node.widthMode === "fixed"))
        delta.x *= reference.width / actual.width;
      if (node.verticalConstraint === "scale" && (!node.heightMode || node.heightMode === "fixed"))
        delta.y *= reference.height / actual.height;
    }
    return {
      box: {
        x: Math.max(-100000, Math.min(100000, node.box.x + delta.x)),
        y: Math.max(-100000, Math.min(100000, node.box.y + delta.y)),
      },
    };
  };
  return changedLayers(
    document,
    roots.map((node) => node.id),
    changes,
  );
}

export function moveLayers(
  document: DesignDocument,
  ids: string[],
  x: number,
  y: number,
  renderedParents?: ReadonlyMap<string, { width: number; height: number }>,
) {
  return parseDesignDocument({
    ...document,
    nodes: movedLayers(document, ids, x, y, renderedParents),
  });
}
export function previewMoveLayers(
  document: DesignDocument,
  ids: string[],
  x: number,
  y: number,
  renderedParents?: ReadonlyMap<string, { width: number; height: number }>,
) {
  const old = nodeIndex(document.nodes);
  const nodes = movedLayers(document, ids, x, y, renderedParents).map((node) =>
    old.get(node.id) === node ? node : designNodeSchema.parse(node),
  );
  return { ...document, nodes };
}

export function duplicateLayers(
  document: DesignDocument,
  ids: string[],
  createId: () => string,
): { document: DesignDocument; ids: string[] } {
  let content = document;
  const selected: string[] = [];
  for (const root of selectionRoots(document.nodes, ids)) {
    const copy = duplicateNodeTree(content, root.id, createId);
    content = { ...content, nodes: [...content.nodes, ...copy.nodes] };
    selected.push(copy.rootId);
  }
  return { document: parseDesignDocument(content), ids: selected };
}

/** Preserve import ownership through every browser operation, including bulk edits. */
export function trackDocumentChanges(
  before: DesignDocument,
  after: DesignDocument,
): DesignDocument {
  after = { ...after, nodes: reconcileComponentStructure(before.nodes, after.nodes) };
  const nextNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const edited = new Set(after.editedNodeIds);
  const deleted = [...after.deletedSourceKeys];
  for (const node of before.nodes) {
    const next = nextNodes.get(node.id);
    if (node.importKey && next && !equalJsonValues(node, next)) edited.add(node.id);
    if (!next && node.importKey && node.sourceKey)
      deleted.push({ importKey: node.importKey, sourceKey: node.sourceKey });
  }
  return parseDesignDocument({
    ...after,
    editedNodeIds: [...edited].filter((id) => nextNodes.has(id)),
    deletedSourceKeys: [
      ...new Map(deleted.map((item) => [`${item.importKey}:${item.sourceKey}`, item])).values(),
    ],
  });
}
