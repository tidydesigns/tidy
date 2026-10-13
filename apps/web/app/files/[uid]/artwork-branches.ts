import type { CSSProperties } from "react";
import type { DesignNode } from "@/lib/design/document";
import { booleanRenderNode, vectorCompositeStyle } from "@tidy/design-renderer/vector-composites";

export type ArtworkBranchProps = {
  nodesById: ReadonlyMap<string, DesignNode>;
  childrenById: ReadonlyMap<string | null, readonly DesignNode[]>;
  visibleRootIds: ReadonlySet<string>;
  tokens: Record<string, string>;
  selectedIds: readonly string[];
  prototypeMode: boolean;
  prototypeArtboardId: string | null;
  cropId: string | null;
  editingTextId: string | null;
};

export type Branch = {
  node: DesignNode;
  parent?: DesignNode;
  flowIndex: number;
  viewportWidth: number;
  selected: boolean;
  cropping: boolean;
  editing: boolean;
  children: Branch[];
  painted: DesignNode;
  composite: CSSProperties;
};

/** Node identities and child lists describe immutable render snapshots. */
export function createArtworkBranches() {
  const previous = new WeakMap<DesignNode, Branch>();
  let previousMap: ArtworkBranchProps["nodesById"] | undefined;
  let previousChildren: ArtworkBranchProps["childrenById"] | undefined;
  let allNodes: DesignNode[] = [];
  const dirty = new Set<string>();
  let previousSelection = new Set<string>();
  let previousCrop: string | null = null;
  let previousEditing: string | null = null;
  let previousTokens: ArtworkBranchProps["tokens"] | undefined;
  return (props: ArtworkBranchProps) => {
    const mark = (id: string, map: ArtworkBranchProps["nodesById"]) => {
      let node = map.get(id);
      const visited = new Set<string>();
      while (node && !visited.has(node.id)) {
        visited.add(node.id);
        dirty.add(node.id);
        node = map.get(node.parentId ?? "");
      }
    };
    if (previousMap !== props.nodesById) {
      if (previousMap)
        for (const node of props.nodesById.values())
          if (previousMap.get(node.id) !== node) {
            mark(node.id, props.nodesById);
            mark(node.id, previousMap);
          }
      if (previousMap)
        for (const node of previousMap.values())
          if (!props.nodesById.has(node.id)) mark(node.id, previousMap);
      for (const id of dirty) if (!props.nodesById.has(id)) dirty.delete(id);
      previousMap = props.nodesById;
      allNodes = [...props.nodesById.values()];
    }
    if (previousChildren && previousChildren !== props.childrenById) {
      // A document can reorder siblings without changing any node object.
      // Only quiet parents need this check; changed descendants already dirtied theirs.
      for (const [parentId, children] of props.childrenById) {
        if (parentId === null || dirty.has(parentId)) continue;
        const before = previousChildren.get(parentId);
        if (
          !before ||
          before.length !== children.length ||
          before.some((node, index) => node.id !== children[index].id)
        )
          mark(parentId, props.nodesById);
      }
      for (const parentId of previousChildren.keys())
        if (parentId !== null && !props.childrenById.has(parentId)) mark(parentId, props.nodesById);
    }
    previousChildren = props.childrenById;
    const selection = new Set(props.selectedIds);
    for (const id of new Set([...selection, ...previousSelection]))
      if (selection.has(id) !== previousSelection.has(id)) mark(id, props.nodesById);
    for (const [before, after] of [
      [previousCrop, props.cropId],
      [previousEditing, props.editingTextId],
    ])
      if (before !== after) {
        if (before) mark(before, props.nodesById);
        if (after) mark(after, props.nodesById);
      }
    const tokensChanged = previousTokens !== props.tokens;
    if (previousTokens && tokensChanged) for (const id of props.nodesById.keys()) dirty.add(id);
    previousSelection = selection;
    previousCrop = props.cropId;
    previousEditing = props.editingTextId;
    previousTokens = props.tokens;
    function build(node: DesignNode, flowIndex = 0, frameWidth = node.box.width): Branch | null {
      if (!node.visible || (node.parentId === null && !props.visibleRootIds.has(node.id)))
        return null;
      if (
        props.prototypeMode &&
        node.parentId === null &&
        (node.type !== "artboard" || node.id !== props.prototypeArtboardId)
      )
        return null;
      const viewportWidth = node.type === "artboard" ? node.box.width : frameWidth;
      const parent = props.nodesById.get(node.parentId ?? "");
      const old = previous.get(node);
      // Changed descendants mark their ancestors. Unrelated subtrees need no
      // child traversal, boolean dependency collection, or SVG mask generation.
      if (
        old &&
        !dirty.has(node.id) &&
        !tokensChanged &&
        old.parent === parent &&
        old.flowIndex === flowIndex &&
        old.viewportWidth === viewportWidth
      )
        return old;
      let childFlowIndex = 0;
      const children: Branch[] = [];
      for (const child of props.childrenById.get(node.id) ?? []) {
        const branch = build(child, childFlowIndex, viewportWidth);
        if (child.visible && child.positionMode !== "absolute") childFlowIndex++;
        if (branch) children.push(branch);
      }
      const selected = selection.has(node.id),
        cropping = props.cropId === node.id,
        editing = props.editingTextId === node.id;
      const composite = vectorCompositeStyle(node, allNodes, props.tokens, parent);
      if (
        old &&
        old.parent === parent &&
        old.composite.maskImage === composite.maskImage &&
        old.flowIndex === flowIndex &&
        old.viewportWidth === viewportWidth &&
        old.selected === selected &&
        old.cropping === cropping &&
        old.editing === editing &&
        old.children.length === children.length &&
        old.children.every((child, index) => child === children[index])
      ) {
        dirty.delete(node.id);
        return old;
      }
      const branch = {
        node,
        parent,
        flowIndex,
        viewportWidth,
        selected,
        cropping,
        editing,
        children,
        painted: booleanRenderNode(node, allNodes),
        composite,
      };
      previous.set(node, branch);
      dirty.delete(node.id);
      return branch;
    }
    return (props.childrenById.get(null) ?? []).flatMap((node) => {
      const branch = build(node);
      return branch ? [branch] : [];
    });
  };
}
