import {
  buildDrawnNode,
  nodePageId,
  parseDesignDocument,
  type DesignDocument,
  type DesignNode,
} from "./document";
import { resolvedDocumentNodes } from "./design-tokens";
import { isLayerLocked, isLayerVisible } from "./edit-document";
import { transformedBox, type VectorBoolean } from "@bella/design/vector-boolean";
import { vectorMaskSource, vectorOperand } from "@bella/design/vector-relationships";

function sources(document: DesignDocument, ids: string[]) {
  const selected = resolvedDocumentNodes(document).filter((n) => ids.includes(n.id));
  const first = selected[0],
    parent = document.nodes.find((n) => n.id === first?.parentId);
  if (
    !first ||
    selected.length < 2 ||
    selected.length > 32 ||
    selected.some(
      (n) =>
        n.parentId !== first.parentId ||
        nodePageId(n) !== nodePageId(first) ||
        n.type === "artboard" ||
        isLayerLocked(document.nodes, n.id) ||
        !isLayerVisible(document.nodes, n.id) ||
        n.widthMode === "fill" ||
        n.widthMode === "hug" ||
        n.heightMode === "fill" ||
        n.heightMode === "hug" ||
        (parent && parent.layout !== "absolute" && n.positionMode !== "absolute"),
    )
  )
    throw new Error(
      "Select 2–32 visible, unlocked, fixed-size sibling layers in absolute positioning.",
    );
  return selected;
}
function group(
  document: DesignDocument,
  selected: DesignNode[],
  id: string,
  properties: Partial<DesignNode>,
) {
  if (document.nodes.some((n) => n.id === id)) throw new Error("Group ID already exists.");
  const boxes = selected.map(transformedBox),
    x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  const width = Math.max(1, Math.max(...boxes.map((b) => b.x + b.width)) - x),
    height = Math.max(1, Math.max(...boxes.map((b) => b.y + b.height)) - y);
  const root = {
    ...buildDrawnNode(id, "container", selected[0].parentId, { x, y, width, height }),
    pageId: nodePageId(selected[0]),
    positionMode: "absolute" as const,
    style: {},
    ...properties,
  };
  const chosen = new Set(selected.map((n) => n.id));
  const nodes = document.nodes.map((n) =>
    chosen.has(n.id)
      ? {
          ...n,
          parentId: id,
          box: { ...n.box, x: n.box.x - x, y: n.box.y - y },
          positionMode: "absolute" as const,
          widthMode: "fixed" as const,
          heightMode: "fixed" as const,
        }
      : n,
  );
  nodes.splice(
    nodes.findIndex((n) => chosen.has(n.id)),
    0,
    root,
  );
  return parseDesignDocument({ ...document, nodes });
}
export function createVectorBoolean(
  document: DesignDocument,
  ids: string[],
  operation: VectorBoolean,
  id: string,
) {
  const selected = sources(document, ids);
  if (selected.some((n) => !vectorOperand(n)))
    throw new Error("Boolean operations require editable paths or boolean groups.");
  const style = { ...selected[0].style, rotation: undefined, flipX: undefined, flipY: undefined };
  return group(document, selected, id, {
    name: `${operation[0].toUpperCase()}${operation.slice(1)}`,
    vectorBoolean: operation,
    style,
  });
}
export function createVectorMask(
  document: DesignDocument,
  ids: string[],
  sourceId: string,
  id: string,
) {
  const selected = sources(document, ids),
    source = selected.find((n) => n.id === sourceId);
  if (!source || !vectorMaskSource(source, document.nodes))
    throw new Error("Choose a vector path or vector group as the mask source.");
  return group(document, selected, id, {
    name: "Mask group",
    mask: { sourceId, mode: "alpha", enabled: true },
  });
}
export function releaseVectorComposite(document: DesignDocument, id: string) {
  const node = document.nodes.find((n) => n.id === id);
  if (!node || isLayerLocked(document.nodes, id))
    throw new Error("Unlock this group before releasing its sources.");
  return parseDesignDocument({
    ...document,
    nodes: document.nodes.map((n) =>
      n.id !== id
        ? n
        : {
            ...n,
            vectorBoolean: undefined,
            mask: undefined,
            style: n.vectorBoolean
              ? {
                  ...n.style,
                  paints: [],
                  fill: undefined,
                  fillToken: undefined,
                  gradientFrom: undefined,
                  gradientTo: undefined,
                  strokePaints: [],
                  borderWidth: 0,
                  borderColor: undefined,
                  borderColorToken: undefined,
                }
              : n.style,
          },
    ),
  });
}
