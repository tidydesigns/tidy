"use client";

import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { DesignNode } from "@/lib/design/document";
import {
  serializeContours,
  type VectorAnchor,
  type VectorContour,
  type VectorPoint,
} from "@bella/design/vector-geometry";
import { canvasElements } from "./canvas-elements";
import { elementPlane } from "./vector-editor";
import { useEditorEvent } from "./use-editor-event";

export function PenEditor({
  viewport,
  nodes,
  view,
  pageId,
  spaceHeld,
  onFinish,
  onCancel,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  nodes: DesignNode[];
  view: { x: number; y: number; zoom: number };
  pageId: string;
  spaceHeld: boolean;
  onFinish: (contour: VectorContour, parentId: string | null, pageId: string) => void;
  onCancel: () => void;
}) {
  const [points, setPoints] = useState<VectorAnchor[]>([]);
  const [parentId, setParentId] = useState<string | null>(null);
  const [plane, setPlane] = useState<ReturnType<typeof elementPlane> | undefined>();
  const draft = useRef<{ points: VectorAnchor[]; parentId: string | null; pageId: string } | null>(
    null,
  );
  const active = useRef<{ start: VectorPoint; index: number } | null>(null);
  const finish = useEditorEvent((closed: boolean) => {
    if (!draft.current || draft.current.points.length < 2) return;
    const value = draft.current;
    draft.current = null;
    active.current = null;
    onFinish(
      { id: crypto.randomUUID(), points: value.points, closed },
      value.parentId,
      value.pageId,
    );
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
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(false);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      onCancel();
    }
    if ((event.key === "Backspace" || event.key === "Delete") && draft.current) {
      event.preventDefault();
      event.stopImmediatePropagation();
      draft.current.points = draft.current.points.slice(0, -1);
      setPoints(draft.current.points);
    }
  });
  useLayoutEffect(() => {
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, [keys]);
  const measure = useEditorEvent(() => {
    const canvas = viewport.current,
      parent = parentId ? canvasElements(canvas).get(parentId) : undefined;
    setPlane(canvas && parent ? elementPlane(parent, canvas) : undefined);
  });
  useLayoutEffect(() => {
    measure();
  }, [measure, nodes, parentId, points, view, viewport]);
  const screen = (p: VectorPoint): VectorPoint =>
    plane
      ? plane.screen({ x: p.x + plane.border.x, y: p.y + plane.border.y })
      : { x: p.x * view.zoom + view.x, y: p.y * view.zoom + view.y };
  function local(client: VectorPoint, parentId: string | null): VectorPoint {
    const canvas = viewport.current!,
      rect = canvas.getBoundingClientRect(),
      p = { x: client.x - rect.left, y: client.y - rect.top };
    const element = parentId ? canvasElements(canvas).get(parentId) : undefined;
    if (element) {
      const plane = elementPlane(element, canvas),
        local = plane.local(p);
      return { x: local.x - plane.border.x, y: local.y - plane.border.y };
    }
    return { x: (p.x - view.x) / view.zoom, y: (p.y - view.y) / view.zoom };
  }
  function begin(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || spaceHeld) return;
    event.preventDefault();
    event.stopPropagation();
    viewport.current?.focus({ preventScroll: true });
    if (!draft.current) {
      const canvas = viewport.current!,
        rect = canvas.getBoundingClientRect(),
        screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const candidates = [...canvasElements(canvas).entries()]
        .filter(([id, element]) => {
          const node = nodes.find((n) => n.id === id);
          if (
            !node ||
            !node.visible ||
            node.locked ||
            !["container", "artboard"].includes(node.type)
          )
            return false;
          const plane = elementPlane(element, canvas),
            p = plane.local(screen);
          return p.x >= 0 && p.y >= 0 && p.x <= plane.width && p.y <= plane.height;
        })
        .sort((a, b) =>
          a[1].compareDocumentPosition(b[1]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        );
      draft.current = { points: [], parentId: candidates.at(-1)?.[0] ?? null, pageId };
    }
    setParentId(draft.current.parentId);
    const p = local({ x: event.clientX, y: event.clientY }, draft.current.parentId);
    if (draft.current.points.length >= 2) {
      const first = screen(draft.current.points[0]),
        rect = viewport.current!.getBoundingClientRect();
      if (
        Math.hypot(first.x - (event.clientX - rect.left), first.y - (event.clientY - rect.top)) <= 8
      ) {
        finish(true);
        return;
      }
    }
    if (draft.current.points.length >= 1000) return;
    draft.current.points = [
      ...draft.current.points,
      { id: crypto.randomUUID(), ...p, mode: "corner" },
    ];
    active.current = {
      start: { x: event.clientX, y: event.clientY },
      index: draft.current.points.length - 1,
    };
    setPoints(draft.current.points);
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (
      !active.current ||
      !draft.current ||
      Math.hypot(event.clientX - active.current.start.x, event.clientY - active.current.start.y) < 2
    )
      return;
    const p = draft.current.points[active.current.index],
      out = local({ x: event.clientX, y: event.clientY }, draft.current.parentId);
    draft.current.points = draft.current.points.map((value, index) =>
      index === active.current!.index
        ? { ...value, mode: "symmetric", out, in: { x: 2 * p.x - out.x, y: 2 * p.y - out.y } }
        : value,
    );
    setPoints(draft.current.points);
  }
  const mapped = points.map((p) => ({
    ...p,
    ...screen(p),
    in: p.in ? screen(p.in) : undefined,
    out: p.out ? screen(p.out) : undefined,
  }));
  return (
    <div
      data-pen-editor
      className="absolute inset-0 z-30"
      style={{ pointerEvents: spaceHeld ? "none" : "auto", cursor: "crosshair" }}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={(e) => {
        move(e);
        active.current = null;
      }}
      onPointerCancel={() => {
        if (active.current && draft.current) {
          draft.current.points = draft.current.points.slice(0, -1);
          setPoints(draft.current.points);
        }
        active.current = null;
      }}
    >
      <svg
        className="pointer-events-none absolute inset-0 size-full overflow-visible"
        aria-hidden="true"
      >
        {mapped.length > 0 && (
          <path
            d={serializeContours([{ id: "draft", closed: false, points: mapped }])}
            stroke="var(--color-primary-orange)"
            fill="none"
            strokeWidth="1"
          />
        )}
        {mapped.map((p) => (
          <g key={p.id}>
            {p.out && (
              <>
                <line
                  x1={p.x}
                  y1={p.y}
                  x2={p.out.x}
                  y2={p.out.y}
                  stroke="var(--color-primary-orange)"
                />
                <circle
                  cx={p.out.x}
                  cy={p.out.y}
                  r="3"
                  fill="white"
                  stroke="var(--color-primary-orange)"
                />
              </>
            )}
            <rect
              x={p.x - 4}
              y={p.y - 4}
              width="8"
              height="8"
              fill="white"
              stroke="var(--color-primary-orange)"
            />
          </g>
        ))}
      </svg>
      {points.length > 0 && (
        <div
          className="absolute bottom-5 left-16 flex gap-4 rounded-lg border border-primary-grey bg-primary-white p-3 text-xs shadow-sm"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            disabled={points.length < 2}
            onClick={() => finish(false)}
            className="disabled:opacity-40"
          >
            Finish path
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
