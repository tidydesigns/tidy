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
  return parent
    ? responsiveNode(parent, containingFrameWidth(parent, document.nodes)).layout
    : undefined;
}
export function selectionLayout(selected: DesignNode[], document: DesignDocument) {
  return {
    gridChild: selected.every(
      (item) =>
        item.parentId &&
        parentLayout(item, document) === "grid" &&
        item.positionMode !== "absolute",
    ),
    flowChild: selected.every(
      (item) =>
        item.parentId &&
        ["flex-row", "flex-column"].includes(parentLayout(item, document) ?? "") &&
        item.positionMode !== "absolute",
    ),
  };
}

export type SelectionFeatures = ReturnType<typeof selectionFeatures>;
export type SelectionLayout = ReturnType<typeof selectionLayout>;
