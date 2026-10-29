import {
  designNodeSchema,
  parseDesignDocument,
  type DesignDocument,
  type DesignNode,
  type DesignNodeChanges,
} from "./document";
import { componentEditSession } from "./component-sync";
import { duplicateNodeTree } from "./duplicate-node";
import { rotatePoint } from "./resize-box";
import { innerSize } from "./constraints";
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
  return changedLayerBatch(
    document,
    ids.map((nodeId) => ({ nodeId, changes })),
  );
}

/** Ordered property edits share topology indexes; later edits observe earlier
 * locks, overrides, token materialization and fully settled resize constraints. */
export function changedLayerBatch(
  document: DesignDocument,
  edits: {
    nodeId: string;
    changes: DesignNodeChanges | ((node: DesignNode) => DesignNodeChanges);
  }[],
): DesignNode[] {
  if (!edits.length) return document.nodes;
  const session = componentEditSession(document.nodes, document);
  for (const { nodeId: id, changes } of edits) {
    const node = session.get(id);
    if (!node) continue;
    const patch =
      typeof changes === "function" ? changes(resolveNodeTokens(node, document)) : changes;
    let ancestor: DesignNode | undefined = node;
    let locked = false;
    while (ancestor) {
      if (ancestor.locked || ancestor.librarySource) {
        locked = true;
        break;
      }
      ancestor = ancestor.parentId ? session.get(ancestor.parentId) : undefined;
    }
    if (locked && !(patch.locked === false && Object.keys(patch).length === 1)) continue;
    session.edit(id, patch);
  }
  return session.finish();
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

function layerMovement(
  node: DesignNode,
  byId: ReadonlyMap<string, DesignNode>,
  renderedParents?: ReadonlyMap<string, { width: number; height: number }>,
) {
  const ancestors: DesignNode[] = [];
  let parent = byId.get(node.parentId ?? "");
  while (parent) {
    ancestors.push(parent);
    parent = byId.get(parent.parentId ?? "");
  }
  ancestors.reverse();
  const constraintParent = byId.get(node.parentId ?? "");
  const actual = renderedParents?.get(node.id);
  const reference = constraintParent && actual ? innerSize(constraintParent) : undefined;
  return (x: number, y: number): DesignNodeChanges => {
    let delta = { x, y };
    for (const ancestor of ancestors) {
      delta = rotatePoint(delta, -(ancestor.style.rotation ?? 0));
      if (ancestor.style.flipX) delta.x *= -1;
      if (ancestor.style.flipY) delta.y *= -1;
    }
    if (reference && actual) {
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
}

export function movedLayers(
  document: DesignDocument,
  ids: string[],
  x: number,
  y: number,
  renderedParents?: ReadonlyMap<string, { width: number; height: number }>,
): DesignNode[] {
  const byId = nodeIndex(document.nodes);
  return changedLayers(
    document,
    movableSelectionRoots(document.nodes, ids).map((node) => node.id),
    (node) => layerMovement(node, byId, renderedParents)(x, y),
  );
}

export function prepareMoveLayersPreview(
  document: DesignDocument,
  ids: string[],
  renderedParents?: ReadonlyMap<string, { width: number; height: number }>,
) {
  const byId = nodeIndex(document.nodes);
  const roots = movableSelectionRoots(document.nodes, ids);
  const selected = new Set(roots.map((node) => node.id));
  if (
    roots.some((node) => node.isComponent || node.instanceOf || node.componentSourceId) ||
    document.nodes.some((node) => node.componentSourceId && selected.has(node.componentSourceId))
  )
    return (x: number, y: number) => previewMoveLayers(document, ids, x, y, renderedParents);
  const moves = roots.map((node) => ({
    id: node.id,
    changes: layerMovement(resolveNodeTokens(node, document), byId, renderedParents),
  }));
  const session = componentEditSession(document.nodes, document);
  return (x: number, y: number): DesignDocument => {
    for (const move of moves) session.edit(move.id, move.changes(x, y));
    return {
      ...document,
      nodes: session
        .finish()
        .map((node) => (byId.get(node.id) === node ? node : designNodeSchema.parse(node))),
    };
  };
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
    // This batch validates once below; repeated whole-document validation is
    // quadratic when duplicating many independent roots.
    const copy = duplicateNodeTree(content, root.id, createId, false);
    content = { ...content, nodes: [...content.nodes, ...copy.nodes] };
    selected.push(copy.rootId);
  }
  return { document: parseDesignDocument(content), ids: selected };
}

export { trackDocumentChanges } from "@tidy/design/document-changes";
