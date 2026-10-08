"use client";

import { canvasElements } from "./canvas-elements";
import { useEditorEvent } from "./use-editor-event";
import { useFrameEvent } from "./use-frame-event";
import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { DesignNode } from "@/lib/design/document";
import {
  clamp,
  radialGradientAxes,
  moveRadialRadius,
  gradientStopPoint,
  gradientStopPosition,
  linearGradientLine,
  moveLinearEndpoint,
  translateLinearGradient,
  type GradientEdit,
  type GradientPaint,
  type Point,
  type Size,
} from "@/lib/design/gradient-geometry";

type Control = "start" | "end" | "move" | "center" | "radiusX" | "radiusY" | `stop:${string}`;
type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
  size: Size;
  matrix: DOMMatrix;
};
type Gesture = {
  paint: GradientPaint;
  control: Control;
  point: Point;
  client: Point;
  inverse: DOMMatrix;
  size: Size;
  moved: boolean;
};

/** Overlay outside the layer's clipping; pointer deltas include ancestor rotation, flips, and zoom. */
export function GradientHandles({
  node,
  paint,
  tokens,
  viewport,
  view,
  onBegin,
  onPreview,
  onCommit,
  onCancel,
  onExit,
}: {
  node: DesignNode;
  paint: GradientPaint;
  tokens: Record<string, string>;
  viewport: RefObject<HTMLDivElement | null>;
  view: { x: number; y: number; zoom: number };
  onBegin: () => void;
  onPreview: (edit: GradientEdit, size: Size) => void;
  onCommit: (edit: GradientEdit, size: Size) => void;
  onCancel: () => void;
  onExit: () => void;
}) {
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const previewFrame = useFrameEvent(onPreview);
  const cancelCallback = useRef(onCancel);
  useLayoutEffect(() => {
    cancelCallback.current = onCancel;
  });
  useLayoutEffect(
    () => () => {
      if (gesture.current) {
        gesture.current = null;
        cancelCallback.current();
      }
    },
    [],
  );
  const measureBounds = useEditorEvent(() => {
    const canvas = viewport.current;
    const element = canvasElements(canvas).get(node.id);
    if (!canvas || !element) return;
    const rect = element.getBoundingClientRect(),
      canvasRect = canvas.getBoundingClientRect(),
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
    const left = parseFloat(style.borderLeftWidth),
      top = parseFloat(style.borderTopWidth);
    setBounds({
      x: rect.left + rect.width / 2 - canvasRect.left,
      y: rect.top + rect.height / 2 - canvasRect.top,
      width,
      height,
      left,
      top,
      size: {
        width: Math.max(0.001, width - left - parseFloat(style.borderRightWidth)),
        height: Math.max(0.001, height - top - parseFloat(style.borderBottomWidth)),
      },
      matrix,
    });
  });
  useLayoutEffect(() => {
    measureBounds();
  }, [node, viewport, view, measureBounds]);
  useLayoutEffect(() => {
    const canvas = viewport.current;
    const element = canvasElements(canvas).get(node.id);
    if (!canvas || !element) return;
    const observer = new ResizeObserver(measureBounds);
    observer.observe(element);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [node.id, viewport, measureBounds]);

  function pointFor(control: Control, source: GradientPaint, size: Size): Point {
    if (control.startsWith("stop:"))
      return gradientStopPoint(
        source,
        source.stops.find((stop) => stop.id === control.slice(5))!.position,
        size,
      );
    if (source.type === "linear") {
      const line = linearGradientLine(source, size);
      return control === "start"
        ? line.start
        : control === "end"
          ? line.end
          : { x: (line.start.x + line.end.x) / 2, y: (line.start.y + line.end.y) / 2 };
    }
    return radialGradientAxes(source, size)[
      control === "radiusX" ? "radiusX" : control === "radiusY" ? "radiusY" : "center"
    ];
  }
  function editFor(
    source: GradientPaint,
    control: Control,
    point: Point,
    size: Size,
    shift: boolean,
  ): GradientEdit {
    if (control.startsWith("stop:"))
      return {
        kind: "stop",
        stopId: control.slice(5),
        position: gradientStopPosition(source, point, size),
      };
    if (source.type === "linear") {
      if (control === "start" || control === "end")
        return moveLinearEndpoint(source, control, point, size, shift);
      const origin = pointFor("move", source, size);
      return translateLinearGradient(
        source,
        { x: point.x - origin.x, y: point.y - origin.y },
        size,
      );
    }
    if (control === "center")
      return { kind: "radial", centerX: clamp(point.x, -3, 4), centerY: clamp(point.y, -3, 4) };
    return moveRadialRadius(
      source,
      control === "radiusX" ? "radiusX" : "radiusY",
      point,
      size,
      shift,
    );
  }
  function begin(event: PointerEvent<HTMLButtonElement>, control: Control) {
    if (event.button !== 0 || !bounds) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    gesture.current = {
      control,
      paint,
      point: pointFor(control, paint, bounds.size),
      client: { x: event.clientX, y: event.clientY },
      inverse: bounds.matrix.inverse(),
      size: bounds.size,
      moved: false,
    };
    onBegin();
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function change(event: PointerEvent<HTMLButtonElement>, start: Gesture) {
    const dx = event.clientX - start.client.x,
      dy = event.clientY - start.client.y;
    return editFor(
      start.paint,
      start.control,
      {
        x: start.point.x + (start.inverse.a * dx + start.inverse.c * dy) / start.size.width,
        y: start.point.y + (start.inverse.b * dx + start.inverse.d * dy) / start.size.height,
      },
      start.size,
      event.shiftKey,
    );
  }
  const cancel = () => {
    previewFrame.cancel();
    if (gesture.current) {
      gesture.current = null;
      onCancel();
    }
  };
  if (!bounds) return null;
  const scale = Math.max(0.001, Math.hypot(bounds.matrix.a, bounds.matrix.b)),
    handleSize = 10 / scale;
  const line =
    paint.type === "linear"
      ? linearGradientLine(paint, bounds.size)
      : {
          start: radialGradientAxes(paint, bounds.size).center,
          end: radialGradientAxes(paint, bounds.size).radiusX,
        };
  const pixel = (point: Point) => ({
    x: point.x * bounds.size.width,
    y: point.y * bounds.size.height,
  });
  const radialY =
    paint.type === "radial" ? pixel(radialGradientAxes(paint, bounds.size).radiusY) : undefined;
  const start = pixel(line.start),
    end = pixel(line.end),
    length = Math.max(0.001, Math.hypot(end.x - start.x, end.y - start.y));
  const offset = {
    x: ((-(end.y - start.y) / length) * 18) / scale,
    y: (((end.x - start.x) / length) * 18) / scale,
  };
  const controls: { id: Control; label: string; color?: string; position?: number }[] = [
    ...(paint.type === "linear"
      ? [
          { id: "start" as const, label: "Gradient start" },
          { id: "end" as const, label: "Gradient end" },
          { id: "move" as const, label: "Move gradient" },
        ]
      : [
          { id: "center" as const, label: "Gradient center" },
          { id: "radiusX" as const, label: "Gradient radius X" },
          { id: "radiusY" as const, label: "Gradient radius Y" },
        ]),
    ...paint.stops.map((stop, index) => ({
      id: `stop:${stop.id}` as const,
      label: `Gradient stop ${index + 1}`,
      color: stop.token ? (tokens[stop.token] ?? stop.color) : stop.color,
      position: stop.position,
    })),
  ];
  return (
    <div
      data-canvas-control
      data-gradient-controls
      className="pointer-events-none absolute z-30"
      style={{ left: bounds.x, top: bounds.y }}
    >
      <div
        style={{
          position: "absolute",
          width: bounds.width,
          height: bounds.height,
          left: -bounds.width / 2,
          top: -bounds.height / 2,
          transform: `matrix(${bounds.matrix.a}, ${bounds.matrix.b}, ${bounds.matrix.c}, ${bounds.matrix.d}, 0, 0)`,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: bounds.left,
            top: bounds.top,
            width: bounds.size.width,
            height: bounds.size.height,
          }}
        >
          <svg
            aria-hidden="true"
            className="absolute overflow-visible"
            width={bounds.size.width}
            height={bounds.size.height}
          >
            <line
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              stroke="var(--color-handle)"
              strokeWidth={3 / scale}
            />
            <line
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              stroke="var(--color-primary-orange)"
              strokeWidth={1 / scale}
            />
            {paint.type === "radial" && (
              <>
                <line
                  x1={start.x}
                  y1={start.y}
                  x2={radialY!.x}
                  y2={radialY!.y}
                  stroke="var(--color-handle)"
                  strokeWidth={3 / scale}
                />
                <line
                  x1={start.x}
                  y1={start.y}
                  x2={radialY!.x}
                  y2={radialY!.y}
                  stroke="var(--color-primary-orange)"
                  strokeWidth={1 / scale}
                />
                <ellipse
                  transform={`rotate(${paint.rotation ?? 0} ${start.x} ${start.y})`}
                  cx={start.x}
                  cy={start.y}
                  rx={paint.radiusX * bounds.size.width}
                  ry={paint.radiusY * bounds.size.height}
                  fill="none"
                  stroke="var(--color-primary-orange)"
                  strokeWidth={1 / scale}
                />
              </>
            )}
          </svg>
          {controls.map((control) => {
            const isStop = control.id.startsWith("stop:"),
              point = pixel(pointFor(control.id, paint, bounds.size));
            return (
              <button
                key={control.id}
                type="button"
                aria-label={control.label}
                role={isStop ? "slider" : undefined}
                aria-valuemin={isStop ? 0 : undefined}
                aria-valuemax={isStop ? 100 : undefined}
                aria-valuenow={isStop ? Math.round(control.position! * 100) : undefined}
                title={
                  isStop
                    ? "Drag to position · Arrow keys adjust · Shift for larger steps"
                    : "Drag to adjust · Shift snaps endpoints or locks radial proportions"
                }
                className="pointer-events-auto absolute border border-primary-orange focus-visible:outline-2 focus-visible:outline-primary-orange"
                style={{
                  left: point.x + (isStop ? offset.x : 0),
                  top: point.y + (isStop ? offset.y : 0),
                  width: handleSize,
                  height: handleSize,
                  borderWidth: 1 / scale,
                  background: control.color ?? "white",
                  borderRadius: isStop ? 2 / scale : "50%",
                  transform: "translate(-50%, -50%)",
                  cursor: control.id === "move" || control.id === "center" ? "move" : "grab",
                }}
                onPointerDown={(event) => begin(event, control.id)}
                onPointerMove={(event) => {
                  const active = gesture.current;
                  if (!active) return;
                  event.stopPropagation();
                  if (event.clientX !== active.client.x || event.clientY !== active.client.y)
                    active.moved = true;
                  if (active.moved) previewFrame.schedule(change(event, active), active.size);
                }}
                onPointerUp={(event) => {
                  const active = gesture.current;
                  if (!active) return;
                  event.stopPropagation();
                  previewFrame.cancel();
                  gesture.current = null;
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  if (active.moved) onCommit(change(event, active), active.size);
                  else onCancel();
                }}
                onPointerCancel={cancel}
                onLostPointerCapture={cancel}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    cancel();
                    onExit();
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    cancel();
                    onExit();
                    return;
                  }
                  if (
                    !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (gesture.current) return;
                  const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
                  if (isStop) {
                    onCommit(
                      {
                        kind: "stop",
                        stopId: control.id.slice(5),
                        position:
                          event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? 1
                              : clamp(
                                  control.position! + direction * (event.shiftKey ? 0.1 : 0.01),
                                  0,
                                  1,
                                ),
                      },
                      bounds.size,
                    );
                    return;
                  }
                  if (event.key === "Home" || event.key === "End") return;
                  const step = event.shiftKey ? 10 : 1,
                    point = pointFor(control.id, paint, bounds.size);
                  onCommit(
                    editFor(
                      paint,
                      control.id,
                      {
                        x:
                          point.x +
                          (event.key === "ArrowLeft" || event.key === "ArrowRight"
                            ? (direction * step) / bounds.size.width
                            : 0),
                        y:
                          point.y +
                          (event.key === "ArrowUp" || event.key === "ArrowDown"
                            ? (direction * step) / bounds.size.height
                            : 0),
                      },
                      bounds.size,
                      false,
                    ),
                    bounds.size,
                  );
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
