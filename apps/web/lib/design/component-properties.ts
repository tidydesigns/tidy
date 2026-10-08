import { parseDesignDocument, type DesignDocument, type DesignNode } from "./document";
import { componentSubtreeIds } from "./component-variants";
import { editLayers, isLayerLocked } from "./edit-document";

type Binding = NonNullable<DesignNode["componentProperties"]>[string];
export function propertyTarget(document: DesignDocument, root: DesignNode, binding: Binding) {
  if (root.isComponent) return document.nodes.find((n) => n.id === binding.targetId);
  const ids = componentSubtreeIds(document.nodes, root.id);
  return document.nodes.find((n) => ids.has(n.id) && n.componentSourceId === binding.targetId);
}
export function propertyValue(node: DesignNode, binding: Binding) {
  const p = binding.property;
  if (p === "fill") {
    const paint = node.style.paints?.find((p) => p.visible && p.type === "solid");
    if (paint?.type === "solid") return paint.color;
  }
  return p === "text"
    ? node.text
    : p === "visible"
      ? node.visible
      : p === "width" || p === "height"
        ? node.box[p]
        : node.style[p];
}
export function setComponentProperty(
  document: DesignDocument,
  rootId: string,
  key: string,
  value: string | boolean | number,
) {
  const root = document.nodes.find((n) => n.id === rootId);
  const master = root?.isComponent
    ? root
    : document.nodes.find((n) => n.id === root?.componentSourceId);
  const binding = master?.componentProperties?.[key];
  const target = root && binding && propertyTarget(document, root, binding);
  if (!target || !binding) throw new Error("Component property target is unavailable.");
  const p = binding.property;
  if (p === "visible" && typeof value !== "boolean")
    throw new Error("Visibility requires a boolean.");
  if (
    ["width", "height", "fontSize", "radius"].includes(p) &&
    (typeof value !== "number" || !Number.isFinite(value))
  )
    throw new Error("This property requires a finite number.");
  if (["text", "fill", "color"].includes(p) && typeof value !== "string")
    throw new Error("This property requires text.");
  if (p === "fill")
    return editLayers(document, [target.id], {
      style: {
        fill: value as string,
        fillToken: undefined,
        paints: undefined,
        gradientFrom: undefined,
        gradientTo: undefined,
      },
    });
  if (p === "color")
    return editLayers(document, [target.id], {
      style: { color: value as string, colorToken: undefined },
    });
  return editLayers(
    document,
    [target.id],
    p === "text"
      ? { text: value as string }
      : p === "visible"
        ? { visible: value as boolean }
        : p === "width" || p === "height"
          ? { box: { [p]: value as number } }
          : { style: { [p]: value } },
  );
}
export function exposeComponentProperty(
  document: DesignDocument,
  rootId: string,
  key: string,
  binding: Binding,
) {
  const root = document.nodes.find((n) => n.id === rootId && n.isComponent && !n.librarySource);
  if (!root || isLayerLocked(document.nodes, root.id))
    throw new Error("Choose a local component master.");
  return parseDesignDocument({
    ...document,
    nodes: document.nodes.map((n) =>
      n.id === rootId
        ? { ...n, componentProperties: { ...n.componentProperties, [key]: binding } }
        : n,
    ),
  });
}
