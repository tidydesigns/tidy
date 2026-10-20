import type { DesignDocument, DesignNode } from "../../design/document";
import { nodeIndex } from "../../design/node-index";
import { containingFrameWidth, responsiveNode } from "../../design/responsive-layout";

export function selectionFeatures(selected: DesignNode[]) {
  return {
    multi: selected.length > 1,
    text: selected.every((item) => item.type === "text"),
    containers: selected.every(
      (item) =>
        (item.type === "artboard" || item.type === "container") &&
        !item.vectorBoolean &&
        !item.mask,
    ),
    vector: selected.every((item) => Boolean(item.vectorPath || item.vectorBoolean)),
    hasVector: selected.some((item) => Boolean(item.vectorPath || item.vectorBoolean)),
    image: selected.every(
      (item) =>
        !item.vectorPath &&
        !item.vectorBoolean &&
        (item.type === "image" || item.type === "vector"),
    ),
  };
}
export function parentLayout(item: DesignNode, document: DesignDocument) {
  const parent = nodeIndex(document.nodes).get(item.parentId ?? "");
  if (!parent?.responsiveBreakpoints?.length) return parent?.layout;
  return responsiveNode(parent, containingFrameWidth(parent, document.nodes)).layout;
}
export function selectionLayout(selected: DesignNode[], document: DesignDocument) {
  let gridChild = true;
  let flowChild = true;
  const layouts = new Map<string, DesignNode["layout"] | undefined>();
  for (const item of selected) {
    if (!item.parentId || item.positionMode === "absolute")
      return { gridChild: false, flowChild: false };
    if (!layouts.has(item.parentId)) layouts.set(item.parentId, parentLayout(item, document));
    const layout = layouts.get(item.parentId);
    gridChild &&= layout === "grid";
    flowChild &&= layout === "flex-row" || layout === "flex-column";
    if (!gridChild && !flowChild) break;
  }
  return { gridChild, flowChild };
}

export type SelectionFeatures = ReturnType<typeof selectionFeatures>;
export type SelectionLayout = ReturnType<typeof selectionLayout>;
