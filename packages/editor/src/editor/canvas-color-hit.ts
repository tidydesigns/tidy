import type { DesignNode } from "../design/document";
import { canvasTransform, elementPlane } from "../design/canvas-geometry";
import { strokeWidths } from "../design/strokes";
import {
  firstCanvasColour,
  nodePaintHit,
  pointOnBorder,
  textSampleTransform,
  type ColourHit,
} from "./canvas-colour-sampling";

type Point = Pick<DesignNode["box"], "x" | "y">;

function createTextSampler(
  surface: HTMLElement,
  styleFor: (element: HTMLElement) => CSSStyleDeclaration,
) {
  let context: CanvasRenderingContext2D | null | undefined;
  let range: Range | undefined;
  const matrices = new WeakMap<HTMLElement, DOMMatrix>();
  const textLines = new WeakMap<
    Text,
    Array<{ rect: DOMRect; value: string; metrics: TextMetrics | null }>
  >();
  return (element: HTMLElement, point: Point): string | undefined => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textRange = (range ??= document.createRange());
    const contains = (rect: DOMRect, px = point.x, py = point.y) =>
      px >= rect.left && px < rect.right && py >= rect.top && py < rect.bottom;
    while (walker.nextNode()) {
      const text = walker.currentNode;
      if (!(text instanceof Text)) continue;
      const parent = text.parentElement;
      if (!parent) continue;
      let lines = textLines.get(text);
      if (!lines) {
        textRange.selectNodeContents(text);
        const rects = [...textRange.getClientRects()];
        const value = text.textContent ?? "";
        const spans = rects.map((rect) => ({
          rect,
          start: rects.length === 1 ? 0 : -1,
          end: rects.length === 1 ? value.length : 0,
        }));
        if (rects.length > 1) {
          for (let offset = 0; offset < value.length; offset++) {
            textRange.setStart(text, offset);
            textRange.setEnd(text, offset + 1);
            const rect = textRange.getBoundingClientRect();
            const span = spans.find(({ rect: line }) =>
              contains(line, rect.left + rect.width / 2, rect.top + rect.height / 2),
            );
            if (!span) continue;
            if (span.start < 0) span.start = offset;
            span.end = offset + 1;
          }
        }
        const style = styleFor(parent);
        lines = spans.map(({ rect, start, end }) => {
          let line = value.slice(Math.max(0, start), end);
          if (style.textTransform === "uppercase") line = line.toLocaleUpperCase();
          if (style.textTransform === "lowercase") line = line.toLocaleLowerCase();
          return { rect, value: line, metrics: null };
        });
        textLines.set(text, lines);
      }
      const line = lines.find(({ rect }) => contains(rect));
      if (!line) continue;
      const value = line.value;
      if (!value.trim()) continue;
      const style = styleFor(parent);
      if (context === undefined) {
        const pixel = document.createElement("canvas");
        pixel.width = pixel.height = 1;
        context = pixel.getContext("2d", { willReadFrequently: true });
      }
      if (!context) return;
      context.resetTransform();
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000000";
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      context.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
      context.wordSpacing = style.wordSpacing === "normal" ? "0px" : style.wordSpacing;
      const metrics = (line.metrics ??= context.measureText(value));
      let matrix = matrices.get(parent);
      if (!matrix) {
        matrix = canvasTransform(parent, surface, styleFor);
        matrices.set(parent, matrix);
      }
      const transform = textSampleTransform({ matrix, line: line.rect, metrics, point });
      if (!transform) continue;
      context.setTransform(...transform);
      context.fillText(value, 0, metrics.fontBoundingBoxAscent);
      if (!context.getImageData(0, 0, 1, 1).data[3]) continue;
      context.resetTransform();
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = style.color;
      context.fillRect(0, 0, 1, 1);
      const bytes = context.getImageData(0, 0, 1, 1).data;
      if (bytes[3] === 0) continue;
      return `#${Array.from(bytes.subarray(0, bytes[3] === 255 ? 3 : 4), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    }
  };
}

export function createCanvasColorSampler({
  surface,
  nodes,
  tokens,
}: {
  surface: HTMLElement;
  nodes: ReadonlyMap<string, DesignNode>;
  tokens: Readonly<Record<string, string>>;
}) {
  const styles = new WeakMap<HTMLElement, CSSStyleDeclaration>();
  const visibility = new WeakMap<HTMLElement, boolean>();
  const styleFor = (element: HTMLElement) => {
    let style = styles.get(element);
    if (!style) {
      style = getComputedStyle(element);
      styles.set(element, style);
    }
    return style;
  };
  const isVisible = (element: HTMLElement) => {
    const path: HTMLElement[] = [];
    let visible = true;
    for (
      let current: HTMLElement | null = element;
      current && current !== surface;
      current = current.parentElement
    ) {
      const cached = visibility.get(current);
      if (cached !== undefined) {
        visible = cached;
        break;
      }
      path.push(current);
      if (styleFor(current).opacity === "0") {
        visible = false;
        break;
      }
    }
    for (const ancestor of path) visibility.set(ancestor, visible);
    return visible;
  };
  const textAtPoint = createTextSampler(surface, styleFor);
  return ({ x, y, textOnly = false }: Point & { textOnly?: boolean }): string | undefined => {
    const point = { x, y };
    let viewport: DOMRect | undefined;
    function* hits(): Generator<ColourHit> {
      const seen = new Set<string>();
      for (const hit of document.elementsFromPoint(x, y)) {
        if (!surface.contains(hit)) continue;
        const element = hit.closest<HTMLElement>("[data-node-id]");
        const id = element?.dataset.nodeId;
        if (!element || !id || seen.has(id) || !surface.contains(element)) continue;
        seen.add(id);
        const node = nodes.get(id);
        if (!node || !node.visible || !isVisible(element)) continue;
        if (node.type === "text") {
          const colour = textAtPoint(element, point);
          if (colour) {
            yield { kind: "colour", colour };
            return;
          }
        }
        if (textOnly) continue;
        let onBorder = false;
        const widths = strokeWidths(node.style);
        if (widths.some((width) => width > 0)) {
          viewport ??= surface.getBoundingClientRect();
          const plane = elementPlane(element, surface);
          onBorder = pointOnBorder({
            point: plane.local({ x: x - viewport.left, y: y - viewport.top }),
            size: plane,
            widths,
          });
        }
        yield nodePaintHit({ node, tokens, onBorder });
      }
    }
    return firstCanvasColour(hits());
  };
}
