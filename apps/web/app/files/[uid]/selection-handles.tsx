"use client";

import { CornerRadiusHandles } from "./corner-radius-handles";
import { supportsCornerRadius } from "@/lib/design/corner-radius";

import { canvasElements } from "./canvas-elements";
import { useEditorEvent } from "./use-editor-event";

import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { DesignNode, DesignNodeChanges } from "@/lib/design/document";
import {
  resizeBox,
  resizeHandles,
  rotatePoint,
  rotationFromPointer,
  type ResizeHandle,
} from "@/lib/design/resize-box";
import { resizeImageCrop } from "@/lib/design/image-crop";
import { storedConstraintBox } from "@/lib/design/constraints";
import { useFrameEvent } from "./use-frame-event";
import { renderedNodeBox, renderedParentSize } from "@/lib/design/canvas-geometry";
import { snapLayerResize } from "@/lib/design/resize-snapping";
import type { SnapBox } from "@/lib/design/snapping";

const handles: Record<ResizeHandle, { label: string; x: number; y: number; cursor: string }> = {
  nw: { label: "top left", x: 0, y: 0, cursor: "nwse-resize" },
  n: { label: "top", x: 0.5, y: 0, cursor: "ns-resize" },
  ne: { label: "top right", x: 1, y: 0, cursor: "nesw-resize" },
  e: { label: "right", x: 1, y: 0.5, cursor: "ew-resize" },
  se: { label: "bottom right", x: 1, y: 1, cursor: "nwse-resize" },
  s: { label: "bottom", x: 0.5, y: 1, cursor: "ns-resize" },
  sw: { label: "bottom left", x: 0, y: 1, cursor: "nesw-resize" },
  w: { label: "left", x: 0, y: 0.5, cursor: "ew-resize" },
};
type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  matrix: DOMMatrix;
  box: DesignNode["box"];
  parentSize: { width: number; height: number };
};
type Gesture = {
  kind: ResizeHandle | "rotate";
  node: DesignNode;
  box: DesignNode["box"];
  clientX: number;
  clientY: number;
  inverse: DOMMatrix;
  matrix: DOMMatrix;
  candidates: SnapBox[];
  center: { x: number; y: number };
  angle: number;
  rotationDirection: number;
  parentSize: Bounds["parentSize"];
};

/** Canvas-level controls stay reachable outside rounded/clipped layers. */
export function SelectionHandles({
  node,
  parent,
  viewport,
  view,
  snap,
  snapObjects = false,
  crop = false,
  onBegin,
  onPreview,
  onCommit,
  onCancel,
}: {
  node: DesignNode;
  parent?: DesignNode;
  viewport: RefObject<HTMLDivElement | null>;
  view: { zoom: number; x: number; y: number };
  snap: boolean;
  snapObjects?: boolean;
  crop?: boolean;
  onBegin: () => void;
  onPreview: (changes: DesignNodeChanges) => void;
  onCommit: (changes: DesignNodeChanges) => void;
  onCancel: () => void;
}) {
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const radiusGesture = useRef(false);
  const previewFrame = useFrameEvent(onPreview);
  const measureBounds = useEditorEvent(() => {
    const canvas = viewport.current;
    const element = canvasElements(canvas).get(node.id);
    if (!canvas || !element) return;
    const rect = element!.getBoundingClientRect();
    const parent = canvas!.getBoundingClientRect();
    let matrix = new DOMMatrix();
    for (
      let current: HTMLElement | null = element!;
      current && current !== canvas;
      current = current.parentElement
    ) {
      const transform = getComputedStyle(current).transform;
      if (transform !== "none") matrix = new DOMMatrix(transform).multiply(matrix);
    }
    const style = getComputedStyle(element!);
    const width = parseFloat(style.width),
      height = parseFloat(style.height);
    setBounds({
      x: rect.left + rect.width / 2 - parent.left,
      y: rect.top + rect.height / 2 - parent.top,
      width,
      height,
      matrix,
      box: renderedNodeBox(element!),
      parentSize: renderedParentSize(element!),
    });
  });
  useLayoutEffect(() => {
    if (!radiusGesture.current) measureBounds();
  }, [node, parent, viewport, view, measureBounds]);
  useLayoutEffect(() => {
    const canvas = viewport.current;
    const element = canvasElements(canvas).get(node.id);
    if (!canvas || !element) return;
    const observer = new ResizeObserver(measureBounds);
    observer.observe(element);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [node.id, viewport, measureBounds]);

  function begin(event: PointerEvent<HTMLButtonElement>, kind: Gesture["kind"]) {
    if (event.button !== 0 || !bounds || !viewport.current) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = viewport.current.getBoundingClientRect();
    const center = { x: canvas.left + bounds.x, y: canvas.top + bounds.y };
    const elements = canvasElements(viewport.current),
      selected = elements.get(node.id);
    const candidates =
      kind === "rotate" || crop || !snapObjects
        ? []
        : [...elements.values()]
            .filter((element) => element !== selected && !selected?.contains(element))
            .map((element) => element.getBoundingClientRect())
            .filter((rect) => rect.width > 0 && rect.height > 0)
            .map((rect) => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }));
    gesture.current = {
      kind,
      node,
      box: bounds.box,
      parentSize: bounds.parentSize,
      clientX: event.clientX,
      clientY: event.clientY,
      center,
      inverse: bounds.matrix.inverse(),
      matrix: bounds.matrix,
      candidates,
      rotationDirection: Math.sign(
        (bounds.matrix.a * bounds.matrix.d - bounds.matrix.b * bounds.matrix.c) *
          (node.style.flipX ? -1 : 1) *
          (node.style.flipY ? -1 : 1),
      ),
      angle: (Math.atan2(event.clientY - center.y, event.clientX - center.x) * 180) / Math.PI,
    };
    onBegin();
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function changes(event: PointerEvent<HTMLButtonElement>, start: Gesture): DesignNodeChanges {
    if (start.kind === "rotate") {
      const angle =
        (Math.atan2(event.clientY - start.center.y, event.clientX - start.center.x) * 180) /
        Math.PI;
      return {
        style: {
          rotation: rotationFromPointer(
            start.node.style.rotation ?? 0,
            start.rotationDirection < 0 ? angle : start.angle,
            start.rotationDirection < 0 ? start.angle : angle,
            event.shiftKey,
          ),
        },
      };
    }
    const dx = event.clientX - start.clientX;
    const dy = event.clientY - start.clientY;
    const local = {
      x: start.inverse.a * dx + start.inverse.c * dy,
      y: start.inverse.b * dx + start.inverse.d * dy,
    };
    if (start.node.style.flipX) local.x *= -1;
    if (start.node.style.flipY) local.y *= -1;
    const options = {
      rotation: start.node.style.rotation,
      flipX: start.node.style.flipX,
      flipY: start.node.style.flipY,
      centered: event.altKey,
      aspect: event.shiftKey || start.node.aspectRatioLocked,
      snap,
    };
    const resized = resizeBox(
      start.box,
      start.kind,
      rotatePoint(local, start.node.style.rotation ?? 0),
      options,
    );
    const actualBox =
      snapObjects && !crop && !event.ctrlKey && !event.metaKey
        ? snapLayerResize(
            start.box,
            resized,
            start.kind,
            start.center,
            start.matrix,
            start.candidates,
            6,
            options,
          )
        : resized;
    const cropped = crop ? resizeImageCrop(start.node, start.box, actualBox) : undefined;
    return {
      style: cropped ? { imageCrop: cropped.crop } : undefined,
      box: storedConstraintBox(
        cropped?.box ?? actualBox,
        { ...start.node, widthMode: "fixed", heightMode: "fixed" },
        parent,
        start.parentSize,
      ),
      widthMode: "fixed",
      heightMode: "fixed",
    };
  }
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    if (!gesture.current) return;
    event.stopPropagation();
    previewFrame.schedule(changes(event, gesture.current));
  };
  const finish = (event: PointerEvent<HTMLButtonElement>) => {
    if (!gesture.current) return;
    previewFrame.cancel();
    event.stopPropagation();
    const patch = changes(event, gesture.current);
    gesture.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onCommit(patch);
  };
  const cancel = () => {
    previewFrame.cancel();
    if (!gesture.current) return;
    gesture.current = null;
    onCancel();
  };
  if (!bounds) return null;
  const scale = Math.hypot(bounds.matrix.a, bounds.matrix.b);
  const size = 8 / scale;
  return (
    <div
      data-canvas-control
      className="pointer-events-none absolute z-20"
      style={{ left: bounds.x, top: bounds.y }}
    >
      {!crop && supportsCornerRadius(node) && (
        <CornerRadiusHandles
          node={node}
          bounds={bounds}
          snap={snap}
          onBegin={() => {
            radiusGesture.current = true;
            onBegin();
          }}
          onPreview={onPreview}
          onCommit={(changes) => {
            radiusGesture.current = false;
            onCommit(changes);
          }}
          onCancel={() => {
            radiusGesture.current = false;
            onCancel();
          }}
        />
      )}
      <output
        data-selection-measurement
        aria-label="Selection size"
        className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded bg-primary-orange px-1.5 py-0.5 text-[10px] leading-4 text-on-brand shadow-sm"
        style={{
          top:
            (Math.abs(bounds.matrix.b) * bounds.width + Math.abs(bounds.matrix.d) * bounds.height) /
              2 +
            8,
        }}
      >
        {Math.round(bounds.box.width * 10) / 10} × {Math.round(bounds.box.height * 10) / 10}
      </output>
      <div
        style={{
          width: bounds.width,
          height: bounds.height,
          position: "absolute",
          left: -bounds.width / 2,
          top: -bounds.height / 2,
          transform: `matrix(${bounds.matrix.a}, ${bounds.matrix.b}, ${bounds.matrix.c}, ${bounds.matrix.d}, 0, 0)`,
        }}
      >
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{ border: `${1 / scale}px solid var(--color-primary-orange)` }}
        />
        {resizeHandles.map((handle) => (
          <button
            key={handle}
            type="button"
            aria-label={`${crop ? "Crop" : "Resize"} ${node.name} ${handles[handle].label}`}
            title="Drag to resize · Shift locks proportions · Option resizes from center"
            className="pointer-events-auto absolute rounded-[1px] border border-primary-orange bg-handle focus-visible:outline-2 focus-visible:outline-primary-orange"
            style={{
              left: `${handles[handle].x * 100}%`,
              top: `${handles[handle].y * 100}%`,
              width: size,
              height: size,
              transform: "translate(-50%, -50%)",
              borderWidth: 1 / scale,
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
              const actualBox = resizeBox(
                bounds.box,
                handle,
                {
                  x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
                  y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0,
                },
                {
                  aspect: node.aspectRatioLocked,
                  centered: event.altKey,
                  rotation: node.style.rotation,
                  flipX: node.style.flipX,
                  flipY: node.style.flipY,
                },
              );
              const cropped = crop ? resizeImageCrop(node, bounds.box, actualBox) : undefined;
              onCommit({
                style: cropped ? { imageCrop: cropped.crop } : undefined,
                box: storedConstraintBox(
                  cropped?.box ?? actualBox,
                  { ...node, widthMode: "fixed", heightMode: "fixed" },
                  parent,
                  bounds.parentSize,
                ),
                widthMode: "fixed",
                heightMode: "fixed",
              });
            }}
          />
        ))}
        {!crop && (
          <>
            <span
              aria-hidden="true"
              className="absolute left-1/2 bg-primary-orange"
              style={{ top: -22 / scale, height: 22 / scale, width: 1 / scale }}
            />
            <button
              type="button"
              aria-label={`Rotate ${node.name}`}
              title="Drag to rotate · Shift snaps to 15°"
              className="pointer-events-auto absolute left-1/2 rounded-full border border-primary-orange bg-handle focus-visible:outline-2 focus-visible:outline-primary-orange"
              style={{
                top: -26 / scale,
                width: size + 2 / scale,
                height: size + 2 / scale,
                borderWidth: 1 / scale,
                transform: "translate(-50%, -50%)",
                cursor: "grab",
              }}
              onPointerDown={(event) => begin(event, "rotate")}
              onPointerMove={move}
              onPointerUp={finish}
              onPointerCancel={cancel}
              onLostPointerCapture={cancel}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancel();
                }
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                event.stopPropagation();
                onCommit({
                  style: {
                    rotation: rotationFromPointer(
                      node.style.rotation ?? 0,
                      0,
                      (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 15 : 1),
                    ),
                  },
                });
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
