import type { DesignNode } from "../design/document";
import type { CanvasView } from "../design/canvas-culling";
export type { CanvasView } from "../design/canvas-culling";

export type HoverOutline = {
  readonly id: string;
  readonly kind: "target" | "child";
  readonly points: string;
  readonly clips: readonly string[];
};
type MeasuredHover = {
  readonly outlines: readonly HoverOutline[];
  readonly observed: ReadonlySet<HTMLElement>;
};

/** Geometry belongs to a layout revision, independent of hover and camera position. */
export function createHoverGeometry() {
  const styles = new Map<HTMLElement, CSSStyleDeclaration>();
  const matrices = new Map<HTMLElement, DOMMatrix>();
  const polygons = new Map<HTMLElement, string>();
  const targets = new Map<string, MeasuredHover>();
  const clear = () => {
    styles.clear();
    matrices.clear();
    polygons.clear();
    targets.clear();
  };
  return {
    clear,
    measure({
      canvas,
      target,
      children,
      registry,
      view,
    }: {
      canvas: HTMLElement;
      target: DesignNode;
      children: readonly DesignNode[];
      registry: ReadonlyMap<string, HTMLElement>;
      view: CanvasView;
    }): MeasuredHover {
      const cached = targets.get(target.id);
      if (cached) {
        let connected = true;
        for (const element of cached.observed)
          if (!element.isConnected) {
            connected = false;
            break;
          }
        if (connected) return cached;
      }
      // Bound retained DOM references even when exploring a large document.
      if (targets.size >= 64 || styles.size >= 2048) clear();
      const origin = canvas.getBoundingClientRect();
      const style = (element: HTMLElement) => {
        let value = styles.get(element);
        if (!value) {
          value = getComputedStyle(element);
          styles.set(element, value);
        }
        return value;
      };
      const matrix = (element: HTMLElement): DOMMatrix => {
        const cached = matrices.get(element);
        if (cached) return cached;
        const chain: HTMLElement[] = [];
        let ancestor: HTMLElement | null = element;
        while (ancestor && ancestor !== canvas && !matrices.has(ancestor)) {
          chain.push(ancestor);
          ancestor = ancestor.parentElement;
        }
        let value =
          (ancestor && ancestor !== canvas ? matrices.get(ancestor) : undefined) ??
          new DOMMatrix().scale(1 / view.zoom);
        for (let i = chain.length - 1; i >= 0; i--) {
          const transform = style(chain[i]).transform;
          if (transform !== "none") value = value.multiply(new DOMMatrix(transform));
          matrices.set(chain[i], value);
        }
        return value;
      };
      const polygon = (element: HTMLElement) => {
        const cached = polygons.get(element);
        if (cached) return cached;
        const rect = element.getBoundingClientRect();
        const computed = style(element);
        const width = parseFloat(computed.width),
          height = parseFloat(computed.height);
        // Camera scale is removed before caching: subsequent camera changes only
        // update the shared SVG transform, never these measured world points.
        const transform = matrix(element);
        const x = (rect.left + rect.width / 2 - origin.left - view.x) / view.zoom;
        const y = (rect.top + rect.height / 2 - origin.top - view.y) / view.zoom;
        const points = [
          [0, 0],
          [width, 0],
          [width, height],
          [0, height],
        ]
          .map(
            ([px, py]) =>
              `${x + transform.a * (px - width / 2) + transform.c * (py - height / 2)},${y + transform.b * (px - width / 2) + transform.d * (py - height / 2)}`,
          )
          .join(" ");
        polygons.set(element, points);
        return points;
      };
      const observed = new Set<HTMLElement>([canvas]);
      const outlines: HoverOutline[] = [];
      for (const node of [target, ...children]) {
        const element = registry.get(node.id);
        if (!element?.isConnected) continue;
        const clips: string[] = [];
        let visible = true;
        for (
          let ancestor: HTMLElement | null = element;
          ancestor && ancestor !== canvas;
          ancestor = ancestor.parentElement
        ) {
          observed.add(ancestor);
          const computed = style(ancestor);
          if (
            computed.visibility === "hidden" ||
            computed.display === "none" ||
            computed.opacity === "0"
          ) {
            visible = false;
            break;
          }
          if (
            ancestor !== element &&
            (computed.overflowX !== "visible" || computed.overflowY !== "visible")
          )
            clips.push(polygon(ancestor));
        }
        if (visible)
          outlines.push({
            id: node.id,
            kind: node.id === target.id ? "target" : "child",
            points: polygon(element),
            clips,
          });
      }
      const result = { outlines, observed };
      targets.set(target.id, result);
      return result;
    },
  };
}
