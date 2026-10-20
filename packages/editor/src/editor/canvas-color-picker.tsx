"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { DesignNode } from "../design/document";
import { nodePaints } from "../design/paints";
import { nodeStrokePaints, strokeWidths } from "../design/strokes";
import { normalizeColor } from "../design/selection-colors";

type Request = { apply: (color: string) => void; origin: HTMLElement | null };
const Context = createContext<{
  picking: boolean;
  pick: (apply: Request["apply"], origin: HTMLElement | null) => void;
} | null>(null);
export const useCanvasColorPicker = () => useContext(Context);
const instruction = "Click a solid fill or text colour. Esc to cancel.";

function layerColor(node: DesignNode, element: Element, tokens: Record<string, string>) {
  if (node.type === "text") {
    const value = node.style.colorToken ? tokens[node.style.colorToken] : node.style.color;
    if (value) return normalizeColor(value);
    // Text can inherit its colour. Resolve CSS colour syntax through the browser.
    const pixel = document.createElement("canvas");
    pixel.width = pixel.height = 1;
    const context = pixel.getContext("2d");
    if (!context) return;
    context.fillStyle = getComputedStyle(element).color;
    context.fillRect(0, 0, 1, 1);
    return `#${[...context.getImageData(0, 0, 1, 1).data].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  }
  const fill = nodePaints(node).find((paint) => paint.visible && paint.opacity > 0);
  const paint =
    fill ??
    (strokeWidths(node.style).some((width) => width > 0)
      ? nodeStrokePaints(node).find((paint) => paint.visible && paint.opacity > 0)
      : undefined);
  if (!paint) return null;
  return paint.type === "solid"
    ? normalizeColor(paint.token ? (tokens[paint.token] ?? paint.color) : paint.color)
    : undefined;
}

export function CanvasColorPicker({
  canvas,
  nodes,
  tokens,
  children,
  className,
  "data-mobile-panels-open": mobilePanelsOpen,
}: {
  canvas: RefObject<HTMLDivElement | null>;
  nodes: DesignNode[];
  tokens: Record<string, string>;
  children: ReactNode;
  className: string;
  "data-mobile-panels-open": boolean;
}) {
  const [request, setRequest] = useState<Request | null>(null);
  const [message, setMessage] = useState(instruction);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const cursor = useRef<HTMLSpanElement>(null);
  const pick = useCallback((apply: Request["apply"], origin: HTMLElement | null) => {
    setMessage(instruction);
    setRequest({ apply, origin });
  }, []);
  const picking = Boolean(request);
  const context = useMemo(() => ({ picking, pick }), [picking, pick]);
  const finish = () => {
    restoreFocus.current = request?.origin ?? null;
    setRequest(null);
  };
  useEffect(() => {
    if (!request) {
      restoreFocus.current?.focus({ preventScroll: true });
      restoreFocus.current = null;
      return;
    }
    const surface = canvas.current;
    if (!surface) return;
    surface.focus({ preventScroll: true });
    const moveCursor = (event: PointerEvent) => {
      const marker = cursor.current;
      if (!marker) return;
      marker.hidden = !(event.target instanceof Node && surface.contains(event.target));
      marker.style.transform = `translate3d(${event.clientX - 3}px, ${event.clientY - 21}px, 0)`;
    };
    const hideCursor = (event: PointerEvent) => {
      if (!event.relatedTarget && cursor.current) cursor.current.hidden = true;
    };
    const blockGesture = (event: Event) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest("[data-canvas-color-picker-control]")
      )
        return;
      if (
        !surface.contains(event.target) ||
        event.target.closest("[data-canvas-control], button, input, textarea, select")
      ) {
        if (event.type === "pointerdown") {
          restoreFocus.current = null;
          setRequest(null);
        }
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const choose = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !surface.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const seen = new Set<string>();
      let color: string | null | undefined;
      for (const hit of document.elementsFromPoint(event.clientX, event.clientY)) {
        if (!surface.contains(hit)) continue;
        const element = hit.closest<HTMLElement>("[data-node-id]");
        const id = element?.dataset.nodeId;
        if (!element || !id || seen.has(id)) continue;
        seen.add(id);
        const node = nodes.find((candidate) => candidate.id === id);
        if (!node) continue;
        color = layerColor(node, element, tokens);
        if (color !== null) break;
      }
      if (!color) {
        setMessage("No solid colour here. Choose a solid fill or text, or press Esc.");
        return;
      }
      request.apply(color);
      restoreFocus.current = request.origin;
      setRequest(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        if (
          event.key !== "Tab" &&
          !(
            event.target instanceof Element &&
            event.target.closest("[data-canvas-color-picker-control]")
          )
        )
          event.stopImmediatePropagation();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      restoreFocus.current = request.origin;
      setRequest(null);
    };
    document.addEventListener("pointermove", moveCursor, true);
    document.addEventListener("pointerout", hideCursor, true);
    for (const name of ["pointerdown", "pointerup", "pointermove", "contextmenu"])
      document.addEventListener(name, blockGesture, true);
    document.addEventListener("click", choose, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointermove", moveCursor, true);
      document.removeEventListener("pointerout", hideCursor, true);
      for (const name of ["pointerdown", "pointerup", "pointermove", "contextmenu"])
        document.removeEventListener(name, blockGesture, true);
      document.removeEventListener("click", choose, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [request, canvas, nodes, tokens]);
  return (
    <Context.Provider value={context}>
      <main
        className={className}
        data-mobile-panels-open={mobilePanelsOpen}
        data-picking-canvas-color={request ? "" : undefined}
      >
        {children}
        {request && (
          <span
            ref={cursor}
            hidden
            aria-hidden="true"
            data-canvas-color-picker-cursor
            className="pointer-events-none fixed top-0 left-0 z-[2147483647] h-6 w-6 bg-contain bg-no-repeat"
            style={{
              backgroundImage: `url("${new URL("../assets/icons/eyedropper-cursor.svg", import.meta.url).href}")`,
            }}
          />
        )}
        {request && (
          <div
            data-canvas-color-picker-control
            className="fixed bottom-20 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-primary-grey bg-surface px-3 py-2 text-xs shadow-sm"
          >
            <span role="status">{message}</span>
            <button
              type="button"
              onClick={() => finish()}
              className="rounded px-2 py-1 hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-primary-orange"
            >
              Cancel
            </button>
          </div>
        )}
      </main>
    </Context.Provider>
  );
}
