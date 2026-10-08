import type { DesignDocument, DesignNode } from "./document";
import { authoredPathBounds, booleanRenderNode } from "@bella/design/vector-boolean";
import { strokeOutsets } from "./strokes";
import { nodeEffects, parseCssShadows } from "@bella/design/effects";
import {
  matrixMultiply,
  transformedExportBounds,
  unionExportBounds,
  type ExportBounds,
  type ExportMatrix,
} from "./export-plan";
const translate = (x: number, y: number): ExportMatrix => [1, 0, 0, 1, x, y];
export function elementMatrix(element: HTMLElement): ExportMatrix {
  const style = getComputedStyle(element),
    raw = new DOMMatrix(style.transform === "none" ? undefined : style.transform),
    origin = style.transformOrigin.split(" ").map(parseFloat);
  const parent = element.offsetParent instanceof HTMLElement ? element.offsetParent : null;
  return matrixMultiply(
    translate(
      element.offsetLeft + (parent?.clientLeft ?? 0),
      element.offsetTop + (parent?.clientTop ?? 0),
    ),
    matrixMultiply(
      translate(origin[0] || 0, origin[1] || 0),
      matrixMultiply(
        [raw.a, raw.b, raw.c, raw.d, raw.e, raw.f],
        translate(-origin[0] || 0, -origin[1] || 0),
      ),
    ),
  );
}
export function worldMatrix(element: HTMLElement): ExportMatrix {
  let result = elementMatrix(element),
    parent = element.parentElement?.closest<HTMLElement>("[data-node-id]");
  while (parent) {
    result = matrixMultiply(elementMatrix(parent), result);
    parent = parent.parentElement?.closest<HTMLElement>("[data-node-id]");
  }
  return result;
}
export function exportNodeBounds(
  node: DesignNode,
  element: HTMLElement,
  elements: ReadonlyMap<string, HTMLElement>,
  nodes: ReadonlyMap<string, DesignNode>,
): ExportBounds {
  const style = getComputedStyle(element),
    width = parseFloat(style.width),
    height = parseFloat(style.height),
    resolved = { ...node, box: { ...node.box, width, height } };
  const [top, right, bottom, left] = strokeOutsets(resolved),
    blur = Math.max(
      0,
      ...nodeEffects(node.style)
        .filter((e) => e.visible && e.type === "blur")
        .map((e) => e.amount * 3),
    );
  const shadows = node.style.shadows ?? parseCssShadows(node.style.shadow) ?? [],
    outset = [top, right, bottom, left].map((n) => n + blur);
  for (const shadow of shadows.filter((s) => !s.inset && s.visible !== false)) {
    const radius = Math.max(0, shadow.spread) + shadow.blur * 1.5;
    outset[0] = Math.max(outset[0], radius - shadow.y);
    outset[1] = Math.max(outset[1], radius + shadow.x);
    outset[2] = Math.max(outset[2], radius + shadow.y);
    outset[3] = Math.max(outset[3], radius - shadow.x);
  }
  const painted = authoredPathBounds(booleanRenderNode(resolved, [...nodes.values()]));
  const boxes = [
    transformedExportBounds(
      {
        x: (painted?.x ?? 0) - outset[3],
        y: (painted?.y ?? 0) - outset[0],
        width: (painted?.width ?? width) + outset[1] + outset[3],
        height: (painted?.height ?? height) + outset[0] + outset[2],
      },
      worldMatrix(element),
    ),
  ];
  if (style.overflow === "visible")
    for (const child of element.children) {
      if (!(child instanceof HTMLElement) || !child.dataset.nodeId) continue;
      const descendant = nodes.get(child.dataset.nodeId);
      if (descendant?.visible && getComputedStyle(child).opacity !== "0")
        boxes.push(exportNodeBounds(descendant, child, elements, nodes));
    }
  return unionExportBounds(boxes);
}
/** Freeze the rendered geometry and inherited fonts; selection chrome never enters an export. */
export function exportClone(
  original: HTMLElement,
  node: DesignNode,
  nodes: ReadonlyMap<string, DesignNode>,
  bounds: ExportBounds,
) {
  const clone = original.cloneNode(true) as HTMLElement;
  const copy = (from: Element, to: Element) => {
    if (from instanceof HTMLElement && to instanceof HTMLElement) {
      const style = getComputedStyle(from);
      for (const key of [
        "fontFamily",
        "fontSize",
        "fontWeight",
        "fontStyle",
        "lineHeight",
        "color",
        "textAlign",
        "letterSpacing",
        "textTransform",
        "whiteSpace",
      ] as const)
        to.style[key] = style[key];
      if (from.dataset.nodeId) {
        to.style.width = style.width;
        to.style.height = style.height;
        const source = nodes.get(from.dataset.nodeId);
        to.style.outline = source?.style.outlineWidth
          ? `${source.style.outlineWidth}px solid ${source.style.outlineColor ?? "#000000"}`
          : "none";
        to.dataset.exportMatrix = elementMatrix(from).join(" ");
        to.dataset.exportWidth = String(parseFloat(style.width));
        to.dataset.exportHeight = String(parseFloat(style.height));
      }
      if (from instanceof HTMLImageElement) {
        to.dataset.exportNaturalWidth = String(from.naturalWidth);
        to.dataset.exportNaturalHeight = String(from.naturalHeight);
      }
      to.dataset.exportWidth = String(parseFloat(style.width));
      to.dataset.exportHeight = String(parseFloat(style.height));
    }
    for (let i = 0; i < from.children.length; i++) copy(from.children[i], to.children[i]);
  };
  copy(original, clone);
  const matrix = worldMatrix(original);
  matrix[4] -= bounds.x;
  matrix[5] -= bounds.y;
  clone.dataset.exportMatrix = matrix.join(" ");
  clone.style.position = "absolute";
  clone.style.left = "0";
  clone.style.top = "0";
  clone.style.margin = "0";
  clone.style.transformOrigin = "0 0";
  clone.style.transform = `matrix(${matrix.join(",")})`;
  clone.style.opacity = String(node.style.opacity ?? 1);
  clone.querySelectorAll("button, textarea, [data-stroke-measure]").forEach((e) => e.remove());
  return clone;
}
export function xml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
export function foreignObjectSvg(
  clones: readonly HTMLElement[],
  bounds: ExportBounds,
  width: number,
  height: number,
  fontCss: string,
) {
  const markup = clones.map((e) => new XMLSerializer().serializeToString(e)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${bounds.width} ${bounds.height}"><foreignObject width="${bounds.width}" height="${bounds.height}"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${bounds.width}px;height:${bounds.height}px;overflow:hidden"><style>${xml(fontCss)}</style>${markup}</div></foreignObject></svg>`;
}
export function selectionBounds(
  roots: readonly DesignNode[],
  elements: ReadonlyMap<string, HTMLElement>,
  document: DesignDocument,
) {
  const nodes = new Map(document.nodes.map((n) => [n.id, n]));
  return unionExportBounds(
    roots.map((n) => {
      const e = elements.get(n.id);
      if (!e)
        throw new Error(
          `Layer ${n.name} is not on the canvas. Switch to its page before exporting.`,
        );
      return exportNodeBounds(n, e, elements, nodes);
    }),
  );
}
