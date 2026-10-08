"use client";

import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { DesignNode } from "@/lib/design/document";
import { canvasElements } from "./canvas-elements";
import { useEditorEvent } from "./use-editor-event";
import { useFrameEvent } from "./use-frame-event";
import { PropertyField } from "./property-field";
import { Choice } from "./inspector-controls";
import {
  moveVectorPoint,
  parsePathContours,
  serializeContours,
  setVectorPointMode,
  splitVectorSegment,
  type VectorContour,
  type VectorPoint,
} from "@bella/design/vector-geometry";

export function elementPlane(element: HTMLElement, canvas: HTMLElement) {
  const rect = element.getBoundingClientRect(),
    viewport = canvas.getBoundingClientRect(),
    style = getComputedStyle(element);
  let matrix = new DOMMatrix();
  for (
    let current: HTMLElement | null = element;
    current && current !== canvas;
    current = current.parentElement
  ) {
    const transform = getComputedStyle(current).transform;
    if (transform !== "none") matrix = new DOMMatrix(transform).multiply(matrix);
  }
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

export function VectorEditor({
  node,
  viewport,
  view,
  onBegin,
  onPreview,
  onCommit,
  onCancel,
  onExit,
}: {
  node: DesignNode;
  viewport: RefObject<HTMLDivElement | null>;
  view: { x: number; y: number; zoom: number };
  onBegin: () => void;
  onPreview: (contours: VectorContour[]) => void;
  onCommit: (contours: VectorContour[]) => void;
  onCancel: () => void;
  onExit: () => void;
}) {
  const path = node.vectorPath!;
  const contours = path.contours ?? parsePathContours(path.d);
  const [plane, setPlane] = useState<ReturnType<typeof elementPlane> | null>(null);
  const [selectedId, setSelectedId] = useState(contours[0].points[0].id);
  const gesture = useRef<{
    contours: VectorContour[];
    id: string;
    control: "anchor" | "in" | "out";
    point: VectorPoint;
    start: VectorPoint;
    plane: NonNullable<typeof plane>;
    moved: boolean;
  } | null>(null);
  const preview = useFrameEvent(onPreview);
  const cancel = useEditorEvent(onCancel);
  const measure = useEditorEvent(() => {
    const canvas = viewport.current,
      element = canvasElements(canvas).get(node.id);
    if (canvas && element) setPlane(elementPlane(element, canvas));
  });
  useLayoutEffect(() => {
    measure();
  }, [measure, node, view]);
  useLayoutEffect(() => {
    const canvas = viewport.current,
      element = canvasElements(canvas).get(node.id);
    if (!canvas || !element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, viewport, node.id]);
  useLayoutEffect(
    () => () => {
      preview.cancel();
      if (gesture.current) {
        gesture.current = null;
        cancel();
      }
    },
    [cancel, preview],
  );
  const selectedContour = contours.find((c) => c.points.some((p) => p.id === selectedId));
  const selected = selectedContour?.points.find((p) => p.id === selectedId);
  const commit = (next: VectorContour[]) => {
    onBegin();
    onCommit(next);
  };
  const remove = useEditorEvent(() => {
    if (!selectedContour || selectedContour.points.length <= 2) return;
    commit(
      contours.map((c) =>
        c.id === selectedContour.id
          ? { ...c, points: c.points.filter((p) => p.id !== selectedId) }
          : c,
      ),
    );
    setSelectedId(selectedContour.points.find((p) => p.id !== selectedId)!.id);
  });
  const keys = useEditorEvent((event: KeyboardEvent) => {
    if (
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      (event.target instanceof Element &&
        event.target.closest("input, textarea, select, [contenteditable]"))
    )
      return;
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      event.stopImmediatePropagation();
      preview.cancel();
      gesture.current = null;
      onCancel();
      onExit();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopImmediatePropagation();
      remove();
    } else if (
      selected &&
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const step = event.shiftKey ? 10 : 1;
      commit(
        moveVectorPoint(contours, selected.id, "anchor", {
          x:
            selected.x +
            (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
          y: selected.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0),
        }),
      );
    }
  });
  useLayoutEffect(() => {
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, [keys]);
  if (!plane) return null;
  const screen = (p: VectorPoint): VectorPoint =>
    plane.screen({
      x: ((p.x - path.viewBox.x) / path.viewBox.width) * plane.width,
      y: ((p.y - path.viewBox.y) / path.viewBox.height) * plane.height,
    });
  function begin(
    event: PointerEvent<HTMLButtonElement>,
    id: string,
    control: "anchor" | "in" | "out",
  ) {
    if (event.button !== 0 || !plane) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    setSelectedId(id);
    const p = contours.flatMap((c) => c.points).find((p) => p.id === id)!;
    gesture.current = {
      contours,
      id,
      control,
      point: control === "anchor" ? p : p[control]!,
      start: { x: event.clientX, y: event.clientY },
      plane,
      moved: false,
    };
    onBegin();
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moved(event: PointerEvent<HTMLButtonElement>) {
    const g = gesture.current!;
    const a = g.plane.local(g.start),
      b = g.plane.local({ x: event.clientX, y: event.clientY });
    return moveVectorPoint(g.contours, g.id, g.control, {
      x: g.point.x + ((b.x - a.x) / g.plane.width) * path.viewBox.width,
      y: g.point.y + ((b.y - a.y) / g.plane.height) * path.viewBox.height,
    });
  }
  const control = (p: VectorPoint, id: string, kind: "anchor" | "in" | "out") => {
    const position = screen(p);
    return (
      <button
        key={`${id}:${kind}`}
        type="button"
        aria-label={`${kind === "anchor" ? "Anchor" : kind === "in" ? "Incoming handle" : "Outgoing handle"} ${id}`}
        data-vector-control={kind}
        data-vector-point={id}
        className={`absolute size-2.5 border border-primary-orange ${kind === "anchor" ? "rounded-sm" : "rounded-full"} ${id === selectedId && kind === "anchor" ? "bg-primary-orange" : "bg-primary-white"}`}
        style={{ left: position.x - 5, top: position.y - 5, pointerEvents: "auto" }}
        onPointerDown={(e) => begin(e, id, kind)}
        onPointerMove={(e) => {
          if (!gesture.current) return;
          gesture.current.moved ||=
            Math.hypot(e.clientX - gesture.current.start.x, e.clientY - gesture.current.start.y) >
            1;
          if (gesture.current.moved) preview.schedule(moved(e));
        }}
        onPointerUp={(e) => {
          if (!gesture.current) return;
          preview.cancel();
          const next = moved(e),
            changed = gesture.current.moved;
          gesture.current = null;
          if (changed) onCommit(next);
          else onCancel();
        }}
        onPointerCancel={() => {
          preview.cancel();
          gesture.current = null;
          onCancel();
        }}
      />
    );
  };
  return (
    <div data-vector-editor className="pointer-events-none absolute inset-0 z-30">
      <svg className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
        {contours.flatMap((c) =>
          c.points.slice(0, c.closed ? undefined : -1).map((p, index) => {
            const q = c.points[(index + 1) % c.points.length];
            const d = serializeContours([
              {
                id: c.id,
                closed: false,
                points: [
                  { ...p, ...screen(p), out: p.out ? screen(p.out) : undefined },
                  { ...q, ...screen(q), in: q.in ? screen(q.in) : undefined },
                ],
              },
            ]);
            return (
              <g key={`${c.id}:${p.id}`}>
                <path d={d} fill="none" stroke="var(--color-primary-orange)" strokeWidth="1" />
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth="12"
                  style={{ pointerEvents: "stroke", cursor: "copy" }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    const id = crypto.randomUUID();
                    commit(splitVectorSegment(contours, c.id, index, id));
                    setSelectedId(id);
                  }}
                />
              </g>
            );
          }),
        )}
        {selected &&
          [selected.in, selected.out]
            .filter((p) => p !== undefined)
            .map((p, i) => (
              <line
                key={i}
                x1={screen(selected).x}
                y1={screen(selected).y}
                x2={screen(p!).x}
                y2={screen(p!).y}
                stroke="var(--color-primary-orange)"
                strokeWidth="1"
              />
            ))}
      </svg>
      {contours.flatMap((c) => c.points.map((p) => control(p, p.id, "anchor")))}
      {selected?.in && control(selected.in, selected.id, "in")}
      {selected?.out && control(selected.out, selected.id, "out")}
      {selected && (
        <div
          className="pointer-events-auto absolute bottom-5 left-16 w-64 rounded-lg border border-primary-grey bg-primary-white p-3 shadow-sm"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="grid grid-cols-2 gap-2">
            <PropertyField
              label="Point X"
              numeric
              min={-100000}
              max={100000}
              value={selected.x}
              onCommit={(x) =>
                commit(
                  moveVectorPoint(contours, selected.id, "anchor", { x: Number(x), y: selected.y }),
                )
              }
            />
            <PropertyField
              label="Point Y"
              numeric
              min={-100000}
              max={100000}
              value={selected.y}
              onCommit={(y) =>
                commit(
                  moveVectorPoint(contours, selected.id, "anchor", { x: selected.x, y: Number(y) }),
                )
              }
            />
          </div>
          <Choice
            label="Point type"
            value={selected.mode ?? "corner"}
            choices={[
              ["corner", "Corner"],
              ["smooth", "Smooth"],
              ["symmetric", "Symmetric"],
            ]}
            onChange={(value) =>
              commit(
                setVectorPointMode(
                  contours,
                  selected.id,
                  value as "corner" | "smooth" | "symmetric",
                ),
              )
            }
          />
          <div className="mt-2 flex gap-3 text-xs">
            <button
              type="button"
              disabled={selectedContour!.points.length <= 2}
              onClick={remove}
              className="disabled:opacity-40"
            >
              Delete point
            </button>
            <button
              type="button"
              onClick={() =>
                commit(
                  contours.map((c) =>
                    c.id === selectedContour!.id ? { ...c, closed: !c.closed } : c,
                  ),
                )
              }
            >
              {selectedContour!.closed ? "Open contour" : "Close contour"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
