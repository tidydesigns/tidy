import type { DesignDocument } from "./document";
import { editLayers, previewLayerChanges } from "./edit-document";
import { nodePaints, paintStyle } from "./paints";
import { applyGradientEdit, type GradientEdit, type Size } from "./gradient-geometry";
function gradientChanges(
  node: DesignDocument["nodes"][number],
  paintId: string,
  edit: GradientEdit,
  size: Size,
) {
  const paints = nodePaints(node),
    paint = paints.find((paint) => paint.id === paintId);
  if (
    !paint ||
    (paint.type !== "linear" && paint.type !== "radial") ||
    (edit.kind === "stop" && !paint.stops.some((stop) => stop.id === edit.stopId))
  )
    return {};
  return {
    style: paintStyle(
      paints.map((paint) => (paint.id === paintId ? applyGradientEdit(paint, edit, size) : paint)),
    ),
  };
}
export function editGradientDocument(
  document: DesignDocument,
  nodeId: string,
  paintId: string,
  edit: GradientEdit,
  size: Size,
) {
  return editLayers(document, [nodeId], (node) => gradientChanges(node, paintId, edit, size));
}
export function previewGradientDocument(
  document: DesignDocument,
  nodeId: string,
  paintId: string,
  edit: GradientEdit,
  size: Size,
) {
  const node = document.nodes.find((node) => node.id === nodeId);
  return node
    ? previewLayerChanges(document, [nodeId], gradientChanges(node, paintId, edit, size))
    : document;
}
