import type { DesignNode } from "../design/document";
import { canvasTransform, elementPlane } from "../design/canvas-geometry";
import { nodePaints } from "../design/paints";
import { nodeStrokePaints, strokeWidths } from "../design/strokes";
import { normalizeColor } from "../design/selection-colors";

function textColorAtPoint(
  element: HTMLElement,
  surface: HTMLElement,
  x: number,
  y: number,
): string | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const contains = (rect: DOMRect, px = x, py = y) =>
    px >= rect.left && px < rect.right && py >= rect.top && py < rect.bottom;
  while (walker.nextNode()) {
    const text = walker.currentNode;
    range.selectNodeContents(text);
    const lines = [...range.getClientRects()];
    const line = lines.find((rect) => contains(rect));
    const parent = text.parentElement;
    if (!line || !parent) continue;
    let value = text.textContent ?? "";
    if (lines.length > 1) {
      let start = -1,
        end = 0;
      for (let offset = 0; offset < value.length; offset++) {
        range.setStart(text, offset);
        range.setEnd(text, offset + 1);
        const rect = range.getBoundingClientRect();
        if (contains(line, rect.left + rect.width / 2, rect.top + rect.height / 2)) {
          if (start < 0) start = offset;
          end = offset + 1;
        }
      }
      value = value.slice(Math.max(0, start), end);
    }
    if (!value.trim()) continue;
    const style = getComputedStyle(parent);
    if (style.textTransform === "uppercase") value = value.toLocaleUpperCase();
    if (style.textTransform === "lowercase") value = value.toLocaleLowerCase();
    const pixel = document.createElement("canvas");
    pixel.width = pixel.height = 1;
    const context = pixel.getContext("2d");
    if (!context) return null;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
    context.wordSpacing = style.wordSpacing === "normal" ? "0px" : style.wordSpacing;
    const metrics = context.measureText(value);
    const ascent = metrics.fontBoundingBoxAscent;
    const height = ascent + metrics.fontBoundingBoxDescent;
    const matrix = canvasTransform(parent, surface);
    context.setTransform(
      matrix.a,
      matrix.b,
      matrix.c,
      matrix.d,
      line.left +
        line.width / 2 -
        Math.floor(x) -
        (matrix.a * metrics.width) / 2 -
        (matrix.c * height) / 2,
      line.top +
        line.height / 2 -
        Math.floor(y) -
        (matrix.b * metrics.width) / 2 -
        (matrix.d * height) / 2,
    );
    context.fillText(value, 0, ascent);
    if (!context.getImageData(0, 0, 1, 1).data[3]) continue;
    context.resetTransform();
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = style.color;
    context.fillRect(0, 0, 1, 1);
    const bytes = [...context.getImageData(0, 0, 1, 1).data];
    if (bytes[3] === 255) bytes.pop();
    return `#${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

export function canvasColorAtPoint({
  surface,
  nodes,
  tokens,
  x,
  y,
}: {
  surface: HTMLElement;
  nodes: ReadonlyMap<string, DesignNode>;
  tokens: Record<string, string>;
  x: number;
  y: number;
}): string | undefined {
  const seen = new Set<string>();
  for (const hit of document.elementsFromPoint(x, y)) {
    if (!surface.contains(hit)) continue;
    const element = hit.closest<HTMLElement>("[data-node-id]");
    const id = element?.dataset.nodeId;
    if (!element || !id || seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    if (!node || !node.visible) continue;
    let visible = true;
    for (
      let current: HTMLElement | null = element;
      current && current !== surface;
      current = current.parentElement
    ) {
      if (getComputedStyle(current).opacity === "0") {
        visible = false;
        break;
      }
    }
    if (!visible) continue;
    if (node.type === "text") {
      const color = textColorAtPoint(element, surface, x, y);
      if (color) return color;
    }
    const widths = strokeWidths(node.style);
    const viewport = surface.getBoundingClientRect();
    const plane = elementPlane(element, surface);
    const point = plane.local({ x: x - viewport.left, y: y - viewport.top });
    const onBorder =
      point.y < widths[0] ||
      point.x > plane.width - widths[1] ||
      point.y > plane.height - widths[2] ||
      point.x < widths[3];
    const stroke = onBorder
      ? nodeStrokePaints(node).find((paint) => paint.visible && paint.opacity > 0)
      : undefined;
    const paint = stroke ?? nodePaints(node).find((paint) => paint.visible && paint.opacity > 0);
    if (!paint) continue;
    if (paint.type !== "solid") return;
    return normalizeColor(paint.token ? (tokens[paint.token] ?? paint.color) : paint.color);
  }
}
