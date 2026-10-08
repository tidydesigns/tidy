import {
  nodePageId,
  parseDesignDocument,
  type DesignDocument,
  type DesignNode,
} from "@/lib/design/document";
import { remapComponentProperties, remapComponentVariants } from "./component-variants";
import { remapInteractions } from "@bella/design/prototype";

export function duplicateNodeTree(
  document: DesignDocument,
  nodeId: string,
  createId: () => string = () => crypto.randomUUID(),
) {
  const source = document.nodes.find((node) => node.id === nodeId);
  if (!source || source.locked) throw new Error("Layer not found or locked.");
  const copied = new Set([nodeId]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const node of document.nodes)
      if (node.parentId && copied.has(node.parentId) && !copied.has(node.id)) {
        copied.add(node.id);
        expanded = true;
      }
  }
  const originals = document.nodes.filter((node) => copied.has(node.id));
  const ids = new Map(originals.map((node) => [node.id, createId()]));
  const shift =
    source.type === "artboard"
      ? Math.max(
          0,
          ...document.nodes
            .filter((node) => node.type === "artboard" && nodePageId(node) === nodePageId(source))
            .map((node) => node.box.x + node.box.width),
        ) -
        source.box.x +
        120
      : 24;
  const nodes: DesignNode[] = originals.map((node) => ({
    ...node,
    id: ids.get(node.id)!,
    mask: node.mask
      ? { ...node.mask, sourceId: ids.get(node.mask.sourceId) ?? node.mask.sourceId }
      : undefined,
    parentId: node.id === nodeId ? node.parentId : ids.get(node.parentId!)!,
    name: node.id === nodeId ? `${node.name.slice(0, 115)} copy` : node.name,
    box:
      node.id === nodeId
        ? {
            ...node.box,
            x: node.box.x + shift,
            y: node.type === "artboard" ? node.box.y : node.box.y + 24,
          }
        : node.box,
    variants: remapComponentVariants(node.variants, ids),
    componentProperties: remapComponentProperties(node.componentProperties, ids),
    instanceOf: node.instanceOf ? (ids.get(node.instanceOf) ?? node.instanceOf) : undefined,
    componentSourceId: node.componentSourceId
      ? (ids.get(node.componentSourceId) ?? node.componentSourceId)
      : undefined,
    linkTo: node.linkTo ? (ids.get(node.linkTo) ?? node.linkTo) : undefined,
    interactions: remapInteractions(node.interactions, (id) => ids.get(id) ?? id),
    importKey: undefined,
    sourceKey: undefined,
  }));
  parseDesignDocument({ ...document, nodes: [...document.nodes, ...nodes] });
  return { nodes, rootId: ids.get(nodeId)! };
}
