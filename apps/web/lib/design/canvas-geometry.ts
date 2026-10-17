import type { DesignNode } from "./document";
import type { VectorPoint } from "@tidy/design/vector-geometry";

export function renderedNodeBox(element: HTMLElement): DesignNode["box"] {
  const style = getComputedStyle(element);
  return {
    x: parseFloat(style.left) || element.offsetLeft,
    y: parseFloat(style.top) || element.offsetTop,
    width: parseFloat(style.width),
    height: parseFloat(style.height),
  };
}

/** Read the untransformed padding box used by positioned children. */
export function renderedParentSize(element: HTMLElement) {
  const style = getComputedStyle(element.parentElement!);
  return {
    width: Math.max(
      1,
      parseFloat(style.width) -
        parseFloat(style.borderLeftWidth) -
        parseFloat(style.borderRightWidth),
    ),
    height: Math.max(
      1,
      parseFloat(style.height) -
        parseFloat(style.borderTopWidth) -
        parseFloat(style.borderBottomWidth),
    ),
  };
}

/** Compose layer transforms up to the canvas, including ancestor rotation, flips, and zoom. */
export function canvasTransform(element: HTMLElement, canvas: HTMLElement) {
  let matrix = new DOMMatrix();
  for (
    let current: HTMLElement | null = element;
    current && current !== canvas;
    current = current.parentElement
  ) {
    const transform = getComputedStyle(current).transform;
    if (transform !== "none") matrix = new DOMMatrix(transform).multiply(matrix);
  }
  return matrix;
}

export function elementPlane(element: HTMLElement, canvas: HTMLElement) {
  const rect = element.getBoundingClientRect(),
    viewport = canvas.getBoundingClientRect(),
    style = getComputedStyle(element);
  const matrix = canvasTransform(element, canvas);
  const width = parseFloat(style.width),
    height = parseFloat(style.height);
  const center = {
    x: rect.left + rect.width / 2 - viewport.left,
    y: rect.top + rect.height / 2 - viewport.top,
  };
  return {
    width,
    height,
    screen: (p: VectorPoint): VectorPoint => ({
      x: center.x + matrix.a * (p.x - width / 2) + matrix.c * (p.y - height / 2),
      y: center.y + matrix.b * (p.x - width / 2) + matrix.d * (p.y - height / 2),
    }),
    local: (p: VectorPoint): VectorPoint => {
      const inverse = matrix.inverse(),
        dx = p.x - center.x,
        dy = p.y - center.y;
      return {
        x: width / 2 + inverse.a * dx + inverse.c * dy,
        y: height / 2 + inverse.b * dx + inverse.d * dy,
      };
    },
    border: { x: parseFloat(style.borderLeftWidth), y: parseFloat(style.borderTopWidth) },
  };
}
