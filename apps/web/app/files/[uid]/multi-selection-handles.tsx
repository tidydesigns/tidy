"use client";

import { useFrameEvent } from "./use-frame-event";
import { canvasElements, selectedElements } from "./canvas-elements";

import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { resizeHandles, type ResizeHandle } from "@/lib/design/resize-box";
import { renderedNodeBox } from "@/lib/design/canvas-geometry";

type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  measuredWidth: number;
  measuredHeight: number;
};
type Gesture = {
  kind: "scale" | ResizeHandle;
  x: number;
  y: number;
  bounds: Bounds;
  inverse: DOMMatrix;
};
const handles: Record<ResizeHandle, { x: number; y: number; label: string; cursor: string }> = {
  nw: { x: 0, y: 0, label: "top left", cursor: "nwse-resize" },
  n: { x: 0.5, y: 0, label: "top", cursor: "ns-resize" },
  ne: { x: 1, y: 0, label: "top right", cursor: "nesw-resize" },
  e: { x: 1, y: 0.5, label: "right", cursor: "ew-resize" },
  se: { x: 1, y: 1, label: "bottom right", cursor: "nwse-resize" },
  s: { x: 0.5, y: 1, label: "bottom", cursor: "ns-resize" },
  sw: { x: 0, y: 1, label: "bottom left", cursor: "nesw-resize" },
  w: { x: 0, y: 0.5, label: "left", cursor: "ew-resize" },
};

export function MultiSelectionHandles({
  ids,
  viewport,
  view,
  onBegin,
  onScalePreview,
  onScaleCommit,
  onResizePreview,
  onResizeCommit,
  onCancel,
}: {
  ids: string[];
  viewport: RefObject<HTMLDivElement | null>;
  view: { zoom: number; x: number; y: number };
  onBegin: () => void;
  onScalePreview: (factor: number) => void;
  onScaleCommit: (factor: number) => void;
  onResizePreview: (
    handle: ResizeHandle,
    delta: { x: number; y: number },
    centered: boolean,
    aspect: boolean,
  ) => void;
  onResizeCommit: (
    handle: ResizeHandle,
    delta: { x: number; y: number },
    centered: boolean,
    aspect: boolean,
  ) => void;
  onCancel: () => void;
}) {
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const gesture = useRef<Gesture | null>(null);
  useLayoutEffect(() => {
    const canvas = viewport.current;
    if (!canvas) return;
    const selected = selectedElements(canvas, ids);
    if (selected.length !== ids.length) return;
    function measure() {
      const origin = canvas!.getBoundingClientRect();
      const rects = selected.map((element) => element.getBoundingClientRect());
      const left = Math.min(...rects.map((rect) => rect.left)),
        top = Math.min(...rects.map((rect) => rect.top));
      const boxes = selected.map(renderedNodeBox);
      setBounds({
        x: left - origin.left,
        y: top - origin.top,
        width: Math.max(...rects.map((rect) => rect.right)) - left,
        height: Math.max(...rects.map((rect) => rect.bottom)) - top,
        measuredWidth:
          Math.max(...boxes.map((box) => box.x + box.width)) -
          Math.min(...boxes.map((box) => box.x)),
        measuredHeight:
          Math.max(...boxes.map((box) => box.y + box.height)) -
          Math.min(...boxes.map((box) => box.y)),
      });
    }
    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    selected.forEach((element) => observer.observe(element));
    observer.observe(canvas);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ids, viewport, view]);

  function factor(event: PointerEvent<HTMLButtonElement>, start: Gesture) {
    const dx = (event.clientX - start.x) / Math.max(1, start.bounds.width);
    const dy = (event.clientY - start.y) / Math.max(1, start.bounds.height);
    return Math.max(
      0.01,
      Math.min(100, Math.round((1 + (Math.abs(dx) >= Math.abs(dy) ? dx : dy)) * 1000) / 1000),
    );
  }
  function delta(event: PointerEvent<HTMLButtonElement>, start: Gesture) {
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
    return {
      x: start.inverse.a * dx + start.inverse.c * dy,
      y: start.inverse.b * dx + start.inverse.d * dy,
    };
  }
  function begin(event: PointerEvent<HTMLButtonElement>, kind: Gesture["kind"]) {
    if (event.button !== 0 || !bounds) return;
    event.preventDefault();
    event.stopPropagation();
    const element = canvasElements(viewport.current).get(ids[0]);
    let matrix = new DOMMatrix();
    for (
      let current = element?.parentElement;
      current && current !== viewport.current;
      current = current.parentElement
    ) {
      const transform = getComputedStyle(current).transform;
      if (transform !== "none") matrix = new DOMMatrix(transform).multiply(matrix);
    }
    gesture.current = {
      kind,
      x: event.clientX,
      y: event.clientY,
      bounds,
      inverse: matrix.inverse(),
    };
    onBegin();
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  const previewFrame = useFrameEvent(
    (
      kind: Gesture["kind"],
      value: number | { x: number; y: number },
      centered: boolean,
      aspect: boolean,
    ) => {
      if (kind === "scale") onScalePreview(value as number);
      else onResizePreview(kind, value as { x: number; y: number }, centered, aspect);
    },
  );
  function move(event: PointerEvent<HTMLButtonElement>) {
    if (!gesture.current) return;
    event.stopPropagation();
    const start = gesture.current;
    previewFrame.schedule(
      start.kind,
      start.kind === "scale" ? factor(event, start) : delta(event, start),
      event.altKey,
      event.shiftKey,
    );
  }
  function finish(event: PointerEvent<HTMLButtonElement>) {
    previewFrame.cancel();
    if (!gesture.current) return;
    event.stopPropagation();
    const start = gesture.current;
    gesture.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (start.kind === "scale") onScaleCommit(factor(event, start));
    else onResizeCommit(start.kind, delta(event, start), event.altKey, event.shiftKey);
  }
  function cancel() {
    previewFrame.cancel();
    if (!gesture.current) return;
    gesture.current = null;
    onCancel();
  }
  if (!bounds) return null;
  return (
    <div
      data-canvas-control
      data-multi-selection
      className="pointer-events-none absolute z-20 border border-primary-orange"
      style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}
    >
      <output
        data-selection-measurement
        aria-label="Selection size"
        className="pointer-events-none absolute left-1/2 top-[calc(100%+8px)] -translate-x-1/2 whitespace-nowrap rounded bg-primary-orange px-1.5 py-0.5 text-[10px] leading-4 text-on-brand shadow-sm"
      >
        {Math.round(bounds.measuredWidth * 10) / 10} × {Math.round(bounds.measuredHeight * 10) / 10}
      </output>
      {resizeHandles.map((handle) => (
        <button
          key={handle}
          type="button"
          aria-label={`Resize ${ids.length} layers ${handles[handle].label}`}
          title="Drag to resize · Shift locks proportions · Option resizes from center"
          className="pointer-events-auto absolute h-[8px] w-[8px] -translate-x-1/2 -translate-y-1/2 rounded-[1px] border border-primary-orange bg-handle focus-visible:outline-2 focus-visible:outline-primary-orange"
          style={{
            left: `${handles[handle].x * 100}%`,
            top: `${handles[handle].y * 100}%`,
            cursor: handles[handle].cursor,
          }}
          onPointerDown={(event) => begin(event, handle)}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerCancel={cancel}
          onLostPointerCapture={cancel}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              cancel();
              return;
            }
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const step = event.shiftKey ? 10 : 1;
            onResizeCommit(
              handle,
              {
                x: event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0,
                y: event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0,
              },
              event.altKey,
              false,
            );
          }}
        />
      ))}
      <button
        type="button"
        aria-label={`Scale ${ids.length} layers`}
        title="Drag to scale selection"
        className="pointer-events-auto absolute -bottom-[18px] -right-[18px] h-[10px] w-[10px] rounded-[1px] border border-primary-orange bg-handle focus-visible:outline-2 focus-visible:outline-primary-orange"
        style={{ cursor: "nwse-resize" }}
        onPointerDown={(event) => begin(event, "scale")}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
            return;
          }
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          onScaleCommit(
            ["ArrowRight", "ArrowDown"].includes(event.key)
              ? event.shiftKey
                ? 1.1
                : 1.01
              : event.shiftKey
                ? 0.9
                : 0.99,
          );
        }}
      />
    </div>
  );
}
