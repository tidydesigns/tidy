import { remapInteractions } from "@bella/design/prototype";
import {
  buildDrawnNode,
  nodePageId,
  parseDesignDocument,
  type DesignDocument,
  type DesignNode,
} from "./document";
import { removeComponentReferences, resolveVariantNodes } from "./component-variants";
import { isLayerLocked, isLayerVisible } from "./edit-document";
import { reparentGeometry, type MeasuredBoxes } from "./reparent-geometry";

export function moveLayer(document: DesignDocument, id: string, direction: -1 | 1): DesignDocument {
  const nodes = [...document.nodes];
  const index = nodes.findIndex((node) => node.id === id);
  if (index < 0) return document;
  const node = nodes[index];
  if (isLayerLocked(nodes, id)) throw new Error("Unlock this layer before changing its order.");
  const siblings = nodes
    .map((item, position) => ({ item, position }))
    .filter(({ item }) => item.parentId === node.parentId && nodePageId(item) === nodePageId(node));
  const siblingIndex = siblings.findIndex(({ item }) => item.id === id);
  const other = siblings[siblingIndex + direction];
  if (!other) return document;
  [nodes[index], nodes[other.position]] = [nodes[other.position], nodes[index]];
  return parseDesignDocument({ ...document, nodes });
}

export function groupLayers(
  document: DesignDocument,
  ids: string[],
  groupId: string,
): DesignDocument {
  const selected = document.nodes.filter((node) => ids.includes(node.id));
  if (
    selected.length < 2 ||
    selected.some(
      (node) =>
        node.parentId !== selected[0].parentId ||
        node.type === "artboard" ||
        isLayerLocked(document.nodes, node.id),
    )
  ) {
    throw new Error("Select at least two unlocked sibling layers to group.");
  }
  const left = Math.min(...selected.map((node) => node.box.x));
  const top = Math.min(...selected.map((node) => node.box.y));
  const right = Math.max(...selected.map((node) => node.box.x + node.box.width));
  const bottom = Math.max(...selected.map((node) => node.box.y + node.box.height));
  const group: DesignNode = {
    ...buildDrawnNode(groupId, "container", selected[0].parentId, {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    }),
    pageId: nodePageId(selected[0]),
    name: "Group",
    style: {},
  };
  const selectedIds = new Set(ids);
  const firstIndex = document.nodes.findIndex((node) => selectedIds.has(node.id));
  const nodes = document.nodes.map((node) =>
    selectedIds.has(node.id)
      ? {
          ...node,
          parentId: groupId,
          box: { ...node.box, x: node.box.x - left, y: node.box.y - top },
        }
      : node,
  );
  nodes.splice(firstIndex, 0, group);
  return parseDesignDocument({ ...document, nodes });
}

export function ungroupLayer(document: DesignDocument, groupId: string): DesignDocument {
  const group = document.nodes.find((node) => node.id === groupId);
  if (!group || group.type !== "container" || group.locked || group.isComponent)
    throw new Error("Select an unlocked group or container that is not a component master.");
  const nodes = document.nodes
    .filter((node) => node.id !== groupId)
    .map((node) =>
      node.parentId === groupId
        ? {
            ...node,
            parentId: group.parentId,
            box: { ...node.box, x: node.box.x + group.box.x, y: node.box.y + group.box.y },
          }
        : node,
    );
  return parseDesignDocument({ ...document, nodes });
}

export function alignLayers(
  document: DesignDocument,
  ids: string[],
  axis: "left" | "center-x" | "right" | "top" | "center-y" | "bottom",
  keyObjectId?: string,
): DesignDocument {
  const selected = document.nodes.filter((node) => ids.includes(node.id));
  if (
    !selected.length ||
    selected.some(
      (node) => node.parentId !== selected[0].parentId || isLayerLocked(document.nodes, node.id),
    )
  ) {
    throw new Error("Select unlocked sibling layers to align.");
  }
  const parent =
    selected.length === 1
      ? document.nodes.find((node) => node.id === selected[0].parentId)
      : undefined;
  if (selected.length === 1 && !parent)
    throw new Error("Choose a layer inside a frame to align it.");
  const keyObject = keyObjectId ? selected.find((node) => node.id === keyObjectId) : undefined;
  if (keyObjectId && (!keyObject || selected.length < 2))
    throw new Error("Choose a selected layer as the key object.");
  if (
    selected.some(
      (node) =>
        node.positionMode !== "absolute" &&
        document.nodes.find((item) => item.id === node.parentId)?.layout !== "absolute" &&
        node.parentId,
    )
  ) {
    throw new Error("Use the parent's layout alignment for layers in a flow.");
  }
  const x = keyObject
    ? keyObject.box.x
    : parent
      ? (parent.paddingLeft ?? parent.padding ?? 0)
      : Math.min(...selected.map((node) => node.box.x));
  const y = keyObject
    ? keyObject.box.y
    : parent
      ? (parent.paddingTop ?? parent.padding ?? 0)
      : Math.min(...selected.map((node) => node.box.y));
  const right = keyObject
    ? keyObject.box.x + keyObject.box.width
    : parent
      ? parent.box.width - (parent.paddingRight ?? parent.padding ?? 0)
      : Math.max(...selected.map((node) => node.box.x + node.box.width));
  const bottom = keyObject
    ? keyObject.box.y + keyObject.box.height
    : parent
      ? parent.box.height - (parent.paddingBottom ?? parent.padding ?? 0)
      : Math.max(...selected.map((node) => node.box.y + node.box.height));
  const chosen = new Set(ids);
  const nodes = document.nodes.map((node) => {
    if (!chosen.has(node.id) || node.id === keyObjectId) return node;
    const box = { ...node.box };
    if (axis === "left") box.x = x;
    if (axis === "center-x") box.x = (x + right - box.width) / 2;
    if (axis === "right") box.x = right - box.width;
    if (axis === "top") box.y = y;
    if (axis === "center-y") box.y = (y + bottom - box.height) / 2;
    if (axis === "bottom") box.y = bottom - box.height;
    return { ...node, box };
  });
  return parseDesignDocument({ ...document, nodes });
}

export function distributeLayers(
  document: DesignDocument,
  ids: string[],
  axis: "horizontal" | "vertical",
): DesignDocument {
  const selected = document.nodes.filter((node) => ids.includes(node.id));
  if (
    selected.length < 3 ||
    selected.some(
      (node) => node.parentId !== selected[0].parentId || isLayerLocked(document.nodes, node.id),
    )
  ) {
    throw new Error("Select at least three unlocked sibling layers to distribute.");
  }
  const coordinate = axis === "horizontal" ? "x" : "y";
  const size = axis === "horizontal" ? "width" : "height";
  const ordered = [...selected].sort((a, b) => a.box[coordinate] - b.box[coordinate]);
  const first = ordered[0].box[coordinate];
  const last = ordered.at(-1)!.box[coordinate] + ordered.at(-1)!.box[size];
  const totalSize = ordered.reduce((sum, node) => sum + node.box[size], 0);
  const gap = (last - first - totalSize) / (ordered.length - 1);
  const positions = new Map<string, number>();
  let cursor = first;
  for (const node of ordered) {
    positions.set(node.id, cursor);
    cursor += node.box[size] + gap;
  }
  return parseDesignDocument({
    ...document,
    nodes: document.nodes.map((node) =>
      positions.has(node.id)
        ? { ...node, box: { ...node.box, [coordinate]: positions.get(node.id)! } }
        : node,
    ),
  });
}

export function reparentLayer(
  document: DesignDocument,
  id: string,
  newParentId: string | null,
  boxes?: MeasuredBoxes,
): DesignDocument {
  const node = document.nodes.find((item) => item.id === id);
  const parent = document.nodes.find((item) => item.id === newParentId);
  if (
    !node ||
    isLayerLocked(document.nodes, id) ||
    node.type === "artboard" ||
    (newParentId !== null &&
      (!parent ||
        isLayerLocked(document.nodes, parent.id) ||
        !isLayerVisible(document.nodes, parent.id) ||
        !["artboard", "container"].includes(parent.type)))
  ) {
    throw new Error("Choose an unlocked frame or container for this layer.");
  }
  if (node.parentId === newParentId) return document;
  if (parent && nodePageId(parent) !== nodePageId(node))
    throw new Error("Choose a parent on the same page.");
  for (
    let ancestor: DesignNode | undefined = parent;
    ancestor;
    ancestor = document.nodes.find((item) => item.id === ancestor?.parentId)
  ) {
    if (ancestor.id === id) throw new Error("A layer cannot be placed inside itself.");
  }
  const rendered = resolveVariantNodes(document.nodes);
  const geometry = reparentGeometry(
    rendered,
    node.instanceOf ? rendered.find((item) => item.id === id)! : node,
    newParentId,
    boxes,
  );
  return parseDesignDocument({
    ...document,
    nodes: document.nodes.map((original) => {
      const item =
        original.mask?.sourceId === id && newParentId !== original.id
          ? { ...original, mask: undefined }
          : original;
      return item.id === id
        ? {
            ...item,
            ...geometry,
            style: {
              ...item.style,
              rotation: geometry.style.rotation,
              flipX: geometry.style.flipX,
              flipY: geometry.style.flipY,
            },
            parentId: newParentId,
            positionMode: "absolute",
            widthMode: "fixed",
            heightMode: "fixed",
            horizontalConstraint: "start",
            verticalConstraint: "start",
            ...(item.instanceOf
              ? {
                  instanceOverrides: [
                    ...new Set([
                      ...(item.instanceOverrides ?? []),
                      "box.x",
                      "box.y",
                      "box.width",
                      "box.height",
                      "style.rotation",
                      "style.flipX",
                      "style.flipY",
                      "positionMode",
                      "widthMode",
                      "heightMode",
                      "horizontalConstraint",
                      "verticalConstraint",
                    ]),
                  ],
                }
              : {}),
          }
        : item;
    }),
  });
}

export function makeComponent(document: DesignDocument, id: string): DesignDocument {
  const node = document.nodes.find((item) => item.id === id);
  if (!node || node.type === "artboard" || isLayerLocked(document.nodes, id) || node.instanceOf)
    throw new Error("Choose an unlocked layer to make a component.");
  return parseDesignDocument({
    ...document,
    nodes: document.nodes.map((item) => (item.id === id ? { ...item, isComponent: true } : item)),
  });
}

export function relocateLayer(
  document: DesignDocument,
  id: string,
  targetId: string,
  position: "before" | "inside" | "after",
  boxes?: MeasuredBoxes,
): DesignDocument {
  const node = document.nodes.find((item) => item.id === id);
  const target = document.nodes.find((item) => item.id === targetId);
  if (
    !node ||
    !target ||
    node.id === target.id ||
    isLayerLocked(document.nodes, id) ||
    isLayerLocked(document.nodes, targetId) ||
    nodePageId(node) !== nodePageId(target)
  )
    throw new Error("Choose unlocked layers on the same page.");
  let parent = target.parentId;
  while (parent) {
    if (parent === id) throw new Error("A layer cannot be moved inside its own children.");
    parent = document.nodes.find((item) => item.id === parent)?.parentId ?? null;
  }
  const parentId = position === "inside" ? target.id : target.parentId;
  if (position === "inside" && !["container", "artboard"].includes(target.type))
    throw new Error("Choose a frame or container.");
  if (node.type === "artboard" && parentId !== null)
    throw new Error("Frames must remain on the canvas.");
  const reparented =
    node.parentId === parentId ? document : reparentLayer(document, id, parentId, boxes);
  const moving = reparented.nodes.find((item) => item.id === id)!;
  const remaining = reparented.nodes.filter((item) => item.id !== id);
  const targetIndex = remaining.findIndex((item) => item.id === targetId);
  const index =
    position === "before" ? targetIndex : position === "after" ? targetIndex + 1 : remaining.length;
  remaining.splice(index, 0, moving);
  return parseDesignDocument({ ...reparented, nodes: remaining });
}

export function createComponentInstance(
  document: DesignDocument,
  componentId: string,
  createId: () => string,
): { document: DesignDocument; rootId: string } {
  const root = document.nodes.find((node) => node.id === componentId && node.isComponent);
  if (!root) throw new Error("Component not found.");
  const copied = new Set([root.id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const node of document.nodes)
      if (node.parentId && copied.has(node.parentId) && !copied.has(node.id)) {
        copied.add(node.id);
        changed = true;
      }
  }
  const originals = document.nodes.filter((node) => copied.has(node.id));
  const ids = new Map(originals.map((node) => [node.id, createId()]));
  const nodes: DesignNode[] = originals.map((node) => ({
    ...node,
    id: ids.get(node.id)!,
    mask: node.mask
      ? { ...node.mask, sourceId: ids.get(node.mask.sourceId) ?? node.mask.sourceId }
      : undefined,
    parentId: node.id === root.id ? root.parentId : ids.get(node.parentId!)!,
    name: node.id === root.id ? `${root.name.slice(0, 110)} instance` : node.name,
    box: node.id === root.id ? { ...node.box, x: node.box.x + 24, y: node.box.y + 24 } : node.box,
    isComponent: undefined,
    variants: undefined,
    componentProperties: undefined,
    librarySource: undefined,
    locked: false,
    variant: node.id === root.id ? undefined : node.variant,
    instanceOf: root.id,
    componentSourceId: node.id,
    interactions: remapInteractions(node.interactions, (id) => ids.get(id) ?? id),
    instanceOverrides: node.id === root.id ? ["box.x", "box.y"] : [],
    sourceKey: undefined,
    importKey: undefined,
  }));
  return {
    document: parseDesignDocument({ ...document, nodes: [...document.nodes, ...nodes] }),
    rootId: ids.get(root.id)!,
  };
}

export function removeLayers(document: DesignDocument, ids: string[]): DesignDocument {
  if (ids.some((id) => isLayerLocked(document.nodes, id)))
    throw new Error("Unlock selected layers before deleting them.");
  const removed = new Set(ids);
  for (let changed = true; changed;) {
    changed = false;
    for (const node of document.nodes)
      if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) {
        removed.add(node.id);
        changed = true;
      }
  }
  return parseDesignDocument({
    ...document,
    nodes: removeComponentReferences(document.nodes, removed).map((node) =>
      node.mask && removed.has(node.mask.sourceId) ? { ...node, mask: undefined } : node,
    ),
    editedNodeIds: document.editedNodeIds.filter((id) => !removed.has(id)),
  });
}
