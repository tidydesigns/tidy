import type { DesignDocument, DesignNode } from "./document";
import { xml } from "@tidy/design-renderer/xml";
export { xml } from "@tidy/design-renderer/xml";
import { authoredPathBounds, booleanRenderNode } from "@tidy/design/vector-boolean";
import { strokeOutsets } from "./strokes";
import { nodeEffects, parseCssShadows } from "@tidy/design/effects";
import {
  matrixMultiply,
  transformedExportBounds,
  unionExportBounds,
  type ExportBounds,
  type ExportMatrix,
} from "./export-plan";
const translate = (x: number, y: number): ExportMatrix => [1, 0, 0, 1, x, y];
export function elementMatrix(
  element: HTMLElement,
  style = getComputedStyle(element),
): ExportMatrix {
  const raw = new DOMMatrix(style.transform === "none" ? undefined : style.transform),
    origin = style.transformOrigin.split(" ").map(parseFloat);
  const parent = element.offsetParent instanceof HTMLElement ? element.offsetParent : null;
  const left = parseFloat(style.left),
    top = parseFloat(style.top);
  const x =
    style.position === "absolute" && Number.isFinite(left)
      ? left + (parseFloat(style.marginLeft) || 0)
      : element.offsetLeft;
  const y =
    style.position === "absolute" && Number.isFinite(top)
      ? top + (parseFloat(style.marginTop) || 0)
      : element.offsetTop;
  return matrixMultiply(
    translate(x + (parent?.clientLeft ?? 0), y + (parent?.clientTop ?? 0)),
    matrixMultiply(
      translate(origin[0] || 0, origin[1] || 0),
      matrixMultiply(
        [raw.a, raw.b, raw.c, raw.d, raw.e, raw.f],
        translate(-origin[0] || 0, -origin[1] || 0),
      ),
    ),
  );
}
/** Reuse live DOM reads only during one synchronous bounds/clone operation.
 * Font loading and batch encoding can change layout between these operations. */
function geometryMeasurements() {
  const styles = new WeakMap<HTMLElement, CSSStyleDeclaration>();
  const matrices = new WeakMap<HTMLElement, ExportMatrix>();
  const style = (element: HTMLElement) => {
    let value = styles.get(element);
    if (!value) styles.set(element, (value = getComputedStyle(element)));
    return value;
  };
  return {
    style,
    matrix(element: HTMLElement) {
      let value = matrices.get(element);
      if (!value) matrices.set(element, (value = elementMatrix(element, style(element))));
      return value;
    },
  };
}
export function worldMatrix(
  element: HTMLElement,
  measurements = geometryMeasurements(),
): ExportMatrix {
  let result: ExportMatrix = [...measurements.matrix(element)];
  let parent = element.parentElement?.closest<HTMLElement>("[data-node-id]");
  while (parent) {
    result = matrixMultiply(measurements.matrix(parent), result);
    parent = parent.parentElement?.closest<HTMLElement>("[data-node-id]");
  }
  return result;
}
function exportNodeBounds(
  node: DesignNode,
  element: HTMLElement,
  nodes: ReadonlyMap<string, DesignNode>,
  allNodes: readonly DesignNode[],
  measurements: ReturnType<typeof geometryMeasurements>,
): ExportBounds {
  const style = measurements.style(element),
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
  const painted = authoredPathBounds(booleanRenderNode(resolved, allNodes));
  const boxes = [
    transformedExportBounds(
      {
        x: (painted?.x ?? 0) - outset[3],
        y: (painted?.y ?? 0) - outset[0],
        width: (painted?.width ?? width) + outset[1] + outset[3],
        height: (painted?.height ?? height) + outset[0] + outset[2],
      },
      worldMatrix(element, measurements),
    ),
  ];
  if (style.overflow === "visible")
    for (const child of element.children) {
      if (!(child instanceof HTMLElement) || !child.dataset.nodeId) continue;
      const descendant = nodes.get(child.dataset.nodeId);
      if (descendant?.visible && measurements.style(child).opacity !== "0")
        boxes.push(exportNodeBounds(descendant, child, nodes, allNodes, measurements));
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
  const measurements = geometryMeasurements();
  const copy = (from: Element, to: Element) => {
    if (from instanceof HTMLElement && to instanceof HTMLElement) {
      const style = measurements.style(from);
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
        to.dataset.exportMatrix = measurements.matrix(from).join(" ");
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
  const matrix = worldMatrix(original, measurements);
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
  nodes: ReadonlyMap<string, DesignNode> = new Map(document.nodes.map((n) => [n.id, n])),
) {
  const measurements = geometryMeasurements();
  return unionExportBounds(
    roots.map((n) => {
      const e = elements.get(n.id);
      if (!e)
        throw new Error(
          `Layer ${n.name} is not on the canvas. Switch to its page before exporting.`,
        );
      return exportNodeBounds(n, e, nodes, document.nodes, measurements);
    }),
  );
}
