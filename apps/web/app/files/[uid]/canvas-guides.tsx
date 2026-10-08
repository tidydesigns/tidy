"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import type { CanvasGuide } from "@/lib/design/guides";

type Axis = CanvasGuide["axis"];
type View = { zoom: number; x: number; y: number };
type Gesture = { axis: Axis; id?: string };
type Preview = Gesture & { position: number };

function ticks(axis: Axis, view: View, length: number) {
  const interval =
    [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].find((value) => value * view.zoom >= 70) ??
    10000;
  const offset = axis === "x" ? view.x : view.y;
  const first = Math.floor(-offset / view.zoom / interval) * interval;
  const result: { position: number; label: number }[] = [];
  for (
    let value = first;
    value * view.zoom + offset < length && result.length < 100;
    value += interval
  ) {
    const position = value * view.zoom + offset;
    if (position >= 0) result.push({ position, label: value });
  }
  return result;
}

export function CanvasGuides({
  guides,
  viewport,
  view,
  snapPixels,
  onAdd,
  onMove,
  onRemove,
}: {
  guides: CanvasGuide[];
  viewport: RefObject<HTMLDivElement | null>;
  view: View;
  snapPixels: boolean;
  onAdd: (axis: Axis, position: number) => void;
  onMove: (id: string, position: number) => void;
  onRemove: (id: string) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const width = viewport.current?.clientWidth ?? 0,
    height = viewport.current?.clientHeight ?? 0;
  function world(axis: Axis, event: { clientX: number; clientY: number }) {
    const rect = viewport.current!.getBoundingClientRect();
    const screen = axis === "x" ? event.clientX - rect.left : event.clientY - rect.top;
    const position = (screen - (axis === "x" ? view.x : view.y)) / view.zoom;
    return Math.max(
      -100000,
      Math.min(100000, snapPixels ? Math.round(position) : Math.round(position * 10) / 10),
    );
  }
  function begin(event: PointerEvent<HTMLButtonElement>, axis: Axis, id?: string) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.current = { axis, id };
    setPreview({ axis, id, position: world(axis, event) });
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    if (!gesture.current) return;
    event.stopPropagation();
    setPreview({ ...gesture.current, position: world(gesture.current.axis, event) });
  }
  function finish(event: PointerEvent<HTMLButtonElement>) {
    if (!gesture.current) return;
    event.stopPropagation();
    const current = gesture.current;
    gesture.current = null;
    setPreview(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
    const position = world(current.axis, event);
    if (current.id) onMove(current.id, position);
    else onAdd(current.axis, position);
  }
  function cancel() {
    gesture.current = null;
    setPreview(null);
  }
  function rulerKeyDown(event: KeyboardEvent<HTMLButtonElement>, axis: Axis) {
    if (event.metaKey || event.ctrlKey) return;
    event.stopPropagation();
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    const rect = viewport.current!.getBoundingClientRect();
    onAdd(axis, world(axis, { clientX: rect.left + width / 2, clientY: rect.top + height / 2 }));
  }
  const shown = guides.map((guide) =>
    preview?.id === guide.id ? { ...guide, position: preview.position } : guide,
  );
  if (preview && !preview.id)
    shown.push({ id: "preview", axis: preview.axis, position: preview.position });

  return (
    <div
      data-canvas-control
      data-canvas-guides
      className="pointer-events-none absolute inset-0 z-[15] overflow-hidden"
    >
      {shown.map((guide) => {
        const screen = guide.position * view.zoom + (guide.axis === "x" ? view.x : view.y);
        const draft = guide.id === "preview";
        return (
          <button
            key={guide.id}
            type="button"
            data-page-guide={guide.axis}
            data-guide-position={guide.position}
            aria-label={`${guide.axis === "x" ? "Vertical" : "Horizontal"} guide at ${Math.round(guide.position * 10) / 10} pixels`}
            title="Drag to move · Arrow keys nudge · Delete removes"
            className={`pointer-events-auto absolute touch-none focus-visible:outline-2 focus-visible:outline-primary-orange ${draft ? "pointer-events-none" : ""}`}
            style={
              guide.axis === "x"
                ? {
                    left: screen - 5,
                    top: 20,
                    width: 10,
                    height: Math.max(0, height - 20),
                    cursor: "col-resize",
                  }
                : {
                    top: screen - 5,
                    left: 20,
                    height: 10,
                    width: Math.max(0, width - 20),
                    cursor: "row-resize",
                  }
            }
            onPointerDown={(event) => begin(event, guide.axis, guide.id)}
            onPointerMove={move}
            onPointerUp={finish}
            onPointerCancel={cancel}
            onLostPointerCapture={cancel}
            onKeyDown={(event) => {
              if (!event.metaKey && !event.ctrlKey) event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancel();
                return;
              }
              if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                event.stopPropagation();
                onRemove(guide.id);
                return;
              }
              const step = event.shiftKey ? 10 : 1;
              const delta =
                guide.axis === "x"
                  ? event.key === "ArrowRight"
                    ? step
                    : event.key === "ArrowLeft"
                      ? -step
                      : 0
                  : event.key === "ArrowDown"
                    ? step
                    : event.key === "ArrowUp"
                      ? -step
                      : 0;
              if (delta) {
                event.preventDefault();
                event.stopPropagation();
                onMove(guide.id, Math.max(-100000, Math.min(100000, guide.position + delta)));
              }
            }}
          >
            <span
              aria-hidden="true"
              className={`absolute bg-primary-orange/65 ${guide.axis === "x" ? "left-[4px] top-0 h-full w-px" : "left-0 top-[4px] h-px w-full"}`}
            />
            <span
              aria-hidden="true"
              className={`absolute rounded bg-primary-orange px-1 py-0.5 text-[9px] leading-none text-on-brand ${guide.axis === "x" ? "left-[6px] top-1" : "left-1 top-[6px]"}`}
            >
              {Math.round(guide.position * 10) / 10}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        aria-label="Add vertical guide"
        title="Click or drag to add a vertical guide"
        className="pointer-events-auto absolute left-5 top-0 h-5 bg-primary-white/95 text-[9px] text-secondary-ink focus-visible:outline-2 focus-visible:outline-primary-orange"
        style={{ width: Math.max(0, width - 20) }}
        onPointerDown={(event) => begin(event, "x")}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onKeyDown={(event) => rulerKeyDown(event, "x")}
      >
        {ticks("x", view, width).map((tick) => (
          <span
            key={tick.label}
            aria-hidden="true"
            className="absolute top-0 h-full border-l border-primary-grey/70 pl-1 text-left"
            style={{ left: tick.position - 20 }}
          >
            {tick.label}
          </span>
        ))}
      </button>
      <button
        type="button"
        aria-label="Add horizontal guide"
        title="Click or drag to add a horizontal guide"
        className="pointer-events-auto absolute left-0 top-5 w-5 bg-primary-white/95 text-[9px] text-secondary-ink focus-visible:outline-2 focus-visible:outline-primary-orange"
        style={{ height: Math.max(0, height - 20) }}
        onPointerDown={(event) => begin(event, "y")}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onKeyDown={(event) => rulerKeyDown(event, "y")}
      >
        {ticks("y", view, height).map((tick) => (
          <span
            key={tick.label}
            aria-hidden="true"
            className="absolute left-0 w-full border-t border-primary-grey/70 pt-1 text-left"
            style={{ top: tick.position - 20, writingMode: "vertical-rl" }}
          >
            {tick.label}
          </span>
        ))}
      </button>
      <span
        aria-hidden="true"
        className="absolute left-0 top-0 h-5 w-5 border-b border-r border-primary-grey/70 bg-primary-white/95"
      />
    </div>
  );
}
