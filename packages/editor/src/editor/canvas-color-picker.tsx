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
import { canvasColorAtPoint } from "./canvas-color-hit";
import { canvasColorSnapshot } from "./canvas-color-snapshot";

type Request = { apply: (color: string) => void; origin: HTMLElement | null };
const Context = createContext<{
  picking: boolean;
  cancel: (restore?: boolean) => void;
  pick: (apply: Request["apply"], origin: HTMLElement | null) => void;
} | null>(null);
export const useCanvasColorPicker = () => useContext(Context);
const instruction = "Click to pick a colour. Esc to cancel.";

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
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const [request, setRequest] = useState<Request | null>(null);
  const [message, setMessage] = useState(instruction);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const lens = useRef<HTMLCanvasElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const swatch = useRef<HTMLSpanElement>(null);
  const pick = useCallback((apply: Request["apply"], origin: HTMLElement | null) => {
    setMessage(instruction);
    setRequest({ apply, origin });
  }, []);
  const picking = Boolean(request);
  const finish = useCallback(
    (restore = true) => {
      restoreFocus.current = restore ? (request?.origin ?? null) : null;
      setRequest(null);
    },
    [request],
  );
  const context = useMemo(() => ({ picking, pick, cancel: finish }), [picking, pick, finish]);
  useEffect(() => {
    if (!request) {
      restoreFocus.current?.focus({ preventScroll: true });
      restoreFocus.current = null;
      return;
    }
    const surface = canvas.current;
    if (!surface) return;
    surface.focus({ preventScroll: true });
    if (cursor.current) {
      cursor.current.hidden = true;
      delete cursor.current.dataset.ready;
    }
    const controller = new AbortController();
    let snapshot: Awaited<ReturnType<typeof canvasColorSnapshot>> | undefined;
    let point: { x: number; y: number } | undefined;
    let frame = 0;
    const sample = (x: number, y: number) => {
      const element = document
        .elementsFromPoint(x, y)
        .find((hit) => surface.contains(hit))
        ?.closest<HTMLElement>("[data-node-id]");
      const node = element?.dataset.nodeId ? byId.get(element.dataset.nodeId) : undefined;
      const authored = () => canvasColorAtPoint({ surface, nodes: byId, tokens, x, y });
      if (node?.type === "text" && element) {
        let opaque = true;
        for (
          let current: HTMLElement | null = element;
          current && current !== surface;
          current = current.parentElement
        ) {
          const style = getComputedStyle(current);
          if (style.opacity !== "1" || style.mixBlendMode !== "normal" || style.filter !== "none") {
            opaque = false;
            break;
          }
        }
        const color = opaque
          ? canvasColorAtPoint({ surface, nodes: byId, tokens, x, y, textOnly: true })
          : undefined;
        if (color?.length === 7) return color;
      }
      return snapshot?.colorAt(x, y) ?? authored();
    };
    const draw = () => {
      frame = 0;
      const marker = cursor.current;
      if (!marker || !point) return;
      const { x, y } = point;
      const color = sample(x, y);
      marker.style.transform = `translate3d(${Math.max(8, Math.min(x - 68, window.innerWidth - 144))}px, ${y > 190 ? y - 180 : y + 24}px, 0)`;
      if (readout.current) readout.current.textContent = color?.toUpperCase() ?? "Unavailable";
      if (swatch.current) swatch.current.style.backgroundColor = color ?? "transparent";
      const context = lens.current?.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, 132, 132);
      context.fillStyle = color ?? "#eee";
      context.fillRect(0, 0, 132, 132);
      if (snapshot) {
        context.imageSmoothingEnabled = false;
        context.drawImage(
          snapshot.bitmap,
          Math.floor((x - snapshot.bounds.left) * snapshot.scaleX) - 5,
          Math.floor((y - snapshot.bounds.top) * snapshot.scaleY) - 5,
          11,
          11,
          0,
          0,
          132,
          132,
        );
      }
      context.fillStyle = color ?? "#eee";
      context.fillRect(60, 60, 12, 12);
      context.strokeStyle = "#80808038";
      context.lineWidth = 1;
      context.beginPath();
      for (let offset = 12; offset < 132; offset += 12) {
        context.moveTo(offset, 0);
        context.lineTo(offset, 132);
        context.moveTo(0, offset);
        context.lineTo(132, offset);
      }
      context.stroke();
      context.strokeStyle = "#000";
      context.lineWidth = 3;
      context.strokeRect(60, 60, 12, 12);
      context.strokeStyle = "#fff";
      context.lineWidth = 1;
      context.strokeRect(60, 60, 12, 12);
    };
    void canvasColorSnapshot(surface, nodes, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) {
          result.dispose();
          return;
        }
        snapshot = result;
        if (cursor.current) cursor.current.dataset.ready = "true";
        if (point && !frame) frame = requestAnimationFrame(draw);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setMessage("Image preview unavailable. Pick a solid fill or text colour. Esc to cancel.");
      });
    const moveCursor = (event: PointerEvent) => {
      const marker = cursor.current;
      if (!marker) return;
      marker.hidden = !(
        event.target instanceof Element &&
        surface.contains(event.target) &&
        !event.target.closest("[data-canvas-control], button, input, textarea, select")
      );
      point = marker.hidden ? undefined : { x: event.clientX, y: event.clientY };
      if (point && !frame) frame = requestAnimationFrame(draw);
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
      if (
        !(event.target instanceof Element) ||
        !surface.contains(event.target) ||
        event.target.closest("[data-canvas-control], button, input, textarea, select")
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const color = sample(event.clientX, event.clientY);
      if (!color) {
        setMessage("No colour here. Choose another pixel, or press Esc.");
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
    const invalidate = () => {
      restoreFocus.current = request.origin;
      setRequest(null);
    };
    window.addEventListener("resize", invalidate);
    surface.addEventListener("scroll", invalidate);
    document.addEventListener("wheel", blockGesture, { capture: true, passive: false });
    document.addEventListener("pointermove", moveCursor, true);
    document.addEventListener("pointerout", hideCursor, true);
    for (const name of ["pointerdown", "pointerup", "pointermove", "contextmenu"])
      document.addEventListener(name, blockGesture, true);
    document.addEventListener("click", choose, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("resize", invalidate);
      surface.removeEventListener("scroll", invalidate);
      document.removeEventListener("wheel", blockGesture, true);
      controller.abort();
      snapshot?.dispose();
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", moveCursor, true);
      document.removeEventListener("pointerout", hideCursor, true);
      for (const name of ["pointerdown", "pointerup", "pointermove", "contextmenu"])
        document.removeEventListener(name, blockGesture, true);
      document.removeEventListener("click", choose, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [request, canvas, byId, tokens, nodes]);
  return (
    <Context.Provider value={context}>
      <main
        className={className}
        data-mobile-panels-open={mobilePanelsOpen}
        data-picking-canvas-color={request ? "" : undefined}
      >
        {children}
        {request && (
          <div
            ref={cursor}
            hidden
            aria-hidden="true"
            data-canvas-color-picker-cursor
            className="pointer-events-none fixed top-0 left-0 z-[2147483647] w-[136px] overflow-hidden rounded-xl border-2 border-white bg-surface text-primary-black shadow-[0_4px_20px_#0003,0_0_0_1px_#0003]"
          >
            <canvas ref={lens} width={132} height={132} className="block h-[132px] w-[132px]" />
            <div className="flex h-8 items-center justify-center gap-2 border-t border-primary-grey/50 bg-surface text-[11px] font-medium tabular-nums">
              <span ref={swatch} className="h-3 w-3 rounded-sm border border-primary-grey" />
              <span ref={readout} />
            </div>
          </div>
        )}
        {request && (
          <div
            data-canvas-color-picker-control
            className="fixed top-16 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-primary-grey bg-surface px-3 py-2 text-xs shadow-sm"
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
