"use client";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createImagePool } from "./image-loading";

type ImageElement = HTMLImageElement | SVGSVGElement;
type Measurement = { width: number; height: number; density: number; visible: boolean };
const unmeasured: Measurement = { width: 0, height: 0, density: 1, visible: false };
function createViewport() {
  const pool = createImagePool(true);
  const targets = new Map<
    ImageElement,
    { notify: (value: Measurement) => void; visible: boolean }
  >();
  let intersection: IntersectionObserver | undefined;
  let resize: ResizeObserver | undefined;
  let frame = 0;
  let zoom = 1;
  let selected = new Set<string>();
  const measure = (element: ImageElement) => {
    const target = targets.get(element);
    if (!target) return;
    const nodeId = element.closest("[data-node-id]")?.getAttribute("data-node-id");
    if (!target.visible && (!nodeId || !selected.has(nodeId))) {
      target.notify(unmeasured);
      return;
    }
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    // Keep the unrotated layout dimensions as a lower bound. Rotated bounding
    // boxes alone can underestimate one axis of a long, thin image.
    const matrix = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
    const scale = element instanceof HTMLImageElement ? Math.hypot(matrix.a, matrix.b) : 1;
    target.notify({
      width: Math.max(bounds.width, (parseFloat(style.width) || 0) * zoom * scale),
      height: Math.max(bounds.height, (parseFloat(style.height) || 0) * zoom * scale),
      density: window.devicePixelRatio || 1,
      visible: bounds.width > 0 && bounds.height > 0,
    });
  };
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const element of targets.keys()) measure(element);
    });
  };
  return {
    pool,
    start(root: HTMLElement | null) {
      intersection = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const element = entry.target as ImageElement;
            const target = targets.get(element);
            if (!target) continue;
            target.visible = entry.isIntersecting;
            measure(element);
          }
        },
        { root, rootMargin: "300px" },
      );
      resize = new ResizeObserver(schedule);
      for (const element of targets.keys()) {
        intersection.observe(element);
        resize.observe(element);
      }
      window.addEventListener("resize", schedule);
      return () => {
        intersection?.disconnect();
        resize?.disconnect();
        intersection = undefined;
        resize = undefined;
        cancelAnimationFrame(frame);
        frame = 0;
        window.removeEventListener("resize", schedule);
        pool.clear();
      };
    },
    update(value: number, ids: readonly string[] = []) {
      zoom = value;
      selected = new Set(ids);
      schedule();
    },
    observe(element: ImageElement, notify: (value: Measurement) => void) {
      targets.set(element, { notify, visible: false });
      intersection?.observe(element);
      resize?.observe(element);
      return () => {
        targets.delete(element);
        intersection?.unobserve(element);
        resize?.unobserve(element);
      };
    },
  };
}
type Viewport = ReturnType<typeof createViewport>;
const ImageViewportContext = createContext<Viewport | null>(null);
/** Only images subscribe to view changes; panning never rerenders the artwork tree. */
export function ImageViewportProvider({
  viewport,
  zoom,
  selectedIds,
  children,
}: {
  viewport: RefObject<HTMLElement | null>;
  zoom: number;
  selectedIds?: readonly string[];
  children: ReactNode;
}) {
  const [store] = useState(createViewport);
  useEffect(() => store.start(viewport.current), [store, viewport]);
  useLayoutEffect(() => store.update(zoom, selectedIds), [store, zoom, selectedIds]);
  return <ImageViewportContext.Provider value={store}>{children}</ImageViewportContext.Provider>;
}
export function useImageViewport() {
  const viewport = useContext(ImageViewportContext);
  const [element, ref] = useState<ImageElement | null>(null);
  const [measurement, setMeasurement] = useState(unmeasured);
  useLayoutEffect(() => {
    if (!viewport || !element) return;
    return viewport.observe(element, (next) =>
      setMeasurement((previous) =>
        previous.width === next.width &&
        previous.height === next.height &&
        previous.density === next.density &&
        previous.visible === next.visible
          ? previous
          : next,
      ),
    );
  }, [viewport, element]);
  return { ref, measurement: viewport ? measurement : null, pool: viewport?.pool };
}
