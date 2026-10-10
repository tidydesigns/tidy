import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { DesignNode, DesignNodeChanges } from "@/lib/design/document";
import {
  cornerRadiusChanges,
  radiusCorners,
  radiusHandlePoint,
  radiusHandleRatio,
  renderedRadii,
  type RadiusCorner,
  type RadiusSize,
} from "@/lib/design/corner-radius";
import { useFrameEvent } from "./use-frame-event";
import { useEditorEvent } from "./use-editor-event";

type Bounds = RadiusSize & { matrix: DOMMatrix };
type Gesture = {
  pointerId: number;
  corner: RadiusCorner;
  node: DesignNode;
  size: RadiusSize;
  inverse: DOMMatrix;
  x: number;
  y: number;
  radius: number;
  independent: boolean;
  moved: boolean;
};

/** Four screen-sized controls; no canvas scans, observers or idle animation frames. */
export function CornerRadiusHandles({
  node,
  bounds,
  snap,
  onBegin,
  onPreview,
  onCommit,
  onCancel,
}: {
  node: DesignNode;
  bounds: Bounds;
  snap: boolean;
  onBegin: () => void;
  onPreview: (changes: DesignNodeChanges) => void;
  onCommit: (changes: DesignNodeChanges) => void;
  onCancel: () => void;
}) {
  const gesture = useRef<Gesture | null>(null);
  const [active, setActive] = useState<RadiusCorner | null>(null);
  const [hover, setHover] = useState<RadiusCorner | null>(null);
  const preview = useFrameEvent(onPreview);
  const cancel = useEditorEvent(() => {
    preview.cancel();
    if (!gesture.current) return;
    gesture.current = null;
    setActive(null);
    onCancel();
  });
  useEffect(() => () => cancel(), [cancel]);
  const { width, height, matrix } = bounds;
  const scale = Math.min(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d));
  const radii = renderedRadii(node, bounds);
  function change(event: PointerEvent<HTMLButtonElement>, start: Gesture) {
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
    const localX = start.inverse.a * dx + start.inverse.c * dy;
    const localY = start.inverse.b * dx + start.inverse.d * dy;
    const direction = radiusCorners[start.corner];
    const delta = (localX * direction.x + localY * direction.y) / (2 * radiusHandleRatio);
    const value = start.radius + delta;
    return cornerRadiusChanges(
      start.node,
      start.size,
      start.corner,
      snap ? Math.round(value) : Math.round(value * 100) / 100,
      start.independent,
    );
  }
  // Keep a captured handle mounted if the viewport changes during the gesture.
  if (active === null && (width * scale < 64 || height * scale < 64)) return null;
  const shown = active ?? hover;
  return (
    <div
      data-radius-controls
      className="group/radius pointer-events-none"
      data-dragging={active !== null || undefined}
    >
      <span id={`radius-help-${node.id}`} className="sr-only">
        Drag to round all corners. Hold Alt or Option before dragging to adjust just this corner.
        Arrow keys adjust by one; Shift adjusts by ten.
      </span>
      {radiusCorners.map((corner, index) => {
        const i = index as RadiusCorner;
        const point = radiusHandlePoint(bounds, radii[i], i, scale);
        const x = point.x - width / 2,
          y = point.y - height / 2;
        const left = matrix.a * x + matrix.c * y,
          top = matrix.b * x + matrix.d * y;
        return (
          <button
            key={corner.key}
            type="button"
            data-radius-handle={corner.key}
            aria-label={`Adjust ${node.name} ${corner.label} radius`}
            aria-describedby={`radius-help-${node.id}${shown === i ? ` radius-value-${node.id}` : ""}`}
            className="pointer-events-auto absolute flex size-6 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full opacity-0 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary-orange group-hover/radius:opacity-100 group-focus-within/radius:opacity-100 group-data-[dragging]/radius:opacity-100"
            style={{ left, top, cursor: active === i ? "grabbing" : "grab" }}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            onPointerDown={(event) => {
              if (event.button !== 0 || gesture.current) return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.focus({ preventScroll: true });
              gesture.current = {
                pointerId: event.pointerId,
                corner: i,
                node,
                size: { width, height },
                inverse: matrix.inverse(),
                x: event.clientX,
                y: event.clientY,
                radius: radii[i],
                independent: event.altKey,
                moved: false,
              };
              setActive(i);
              onBegin();
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const start = gesture.current;
              if (!start || start.pointerId !== event.pointerId) return;
              event.stopPropagation();
              if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 2)
                return;
              start.moved = true;
              preview.schedule(change(event, start));
            }}
            onPointerUp={(event) => {
              const start = gesture.current;
              if (!start || start.pointerId !== event.pointerId) return;
              event.stopPropagation();
              preview.cancel();
              gesture.current = null;
              setActive(null);
              event.currentTarget.releasePointerCapture(event.pointerId);
              if (start.moved) onCommit(change(event, start));
              else onCancel();
            }}
            onPointerCancel={(event) => {
              if (gesture.current?.pointerId === event.pointerId) cancel();
            }}
            onLostPointerCapture={(event) => {
              if (gesture.current?.pointerId === event.pointerId) cancel();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancel();
                return;
              }
              if (
                !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) ||
                gesture.current
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              const sign = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1;
              onCommit(
                cornerRadiusChanges(
                  node,
                  bounds,
                  i,
                  radii[i] + sign * (event.shiftKey ? 10 : 1),
                  event.altKey,
                ),
              );
            }}
          >
            <span className="pointer-events-none size-2 rounded-full border border-primary-orange bg-handle" />
          </button>
        );
      })}
      {shown !== null &&
        (() => {
          const point = radiusHandlePoint(bounds, radii[shown], shown, scale);
          const x = point.x - width / 2,
            y = point.y - height / 2;
          const value = node.style[radiusCorners[shown].key] ?? node.style.radius ?? 0;
          return (
            <output
              id={`radius-value-${node.id}`}
              data-radius-value
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-primary-orange px-1.5 py-0.5 text-[10px] leading-4 text-on-brand shadow-sm"
              style={{ left: matrix.a * x + matrix.c * y, top: matrix.b * x + matrix.d * y - 18 }}
            >
              Radius {Math.round(value * 100) / 100}
            </output>
          );
        })()}
    </div>
  );
}
