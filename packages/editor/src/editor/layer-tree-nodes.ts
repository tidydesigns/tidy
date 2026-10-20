import type { DesignNode } from "../design/document";

const fields = [
  "id",
  "parentId",
  "name",
  "sourcePath",
  "type",
  "instanceOf",
  "isComponent",
  "locked",
  "visible",
] as const satisfies readonly (keyof DesignNode)[];

export type LayerTreeNode = Pick<DesignNode, (typeof fields)[number]>;

export function createLayerTreeNodes() {
  let previous: LayerTreeNode[] = [];
  return (nodes: readonly DesignNode[]): LayerTreeNode[] => {
    if (
      nodes.length === previous.length &&
      nodes.every((node, index) => fields.every((field) => node[field] === previous[index][field]))
    )
      return previous;
    previous = nodes.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      name: node.name,
      sourcePath: node.sourcePath,
      type: node.type,
      instanceOf: node.instanceOf,
      isComponent: node.isComponent,
      locked: node.locked,
      visible: node.visible,
    }));
    return previous;
  };
}
