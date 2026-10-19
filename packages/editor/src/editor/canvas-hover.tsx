"use client";

import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import type { DesignNode } from "../design/document";
import { createHoverGeometry, type CanvasView, type HoverOutline } from "./hover-outline-geometry";
import {
  canvasSelectionTarget,
  hoverChildren,
  type SelectionScope,
} from "../design/selection-target";
import { canvasElements } from "./canvas-elements";
import { useEditorEvent } from "./use-editor-event";

type Source =
  | { kind: "none" }
  | { kind: "pressed" }
  | { kind: "canvas"; x: number; y: number; hitId: string | null; direct: boolean }
  | { kind: "layer"; id: string };

type ClipGroup = {
  outlines: HoverOutline[];
  children: Map<string, ClipGroup>;
};

export type CanvasHoverHandle = { previewLayer: (id: string | null) => void };

/** Owns transient feedback; pointer movement never updates FileEditor or artwork props. */
export function CanvasHover({
  ref,
  viewport,
  nodes,
  childrenById,
  selectedIds,
  scope,
  deep,
  readOnly,
  enabled,
  view,
}: {
  ref: Ref<CanvasHoverHandle>;
  viewport: RefObject<HTMLDivElement | null>;
  nodes: ReadonlyMap<string, DesignNode>;
  childrenById: ReadonlyMap<string | null, readonly DesignNode[]>;
  selectedIds: readonly string[];
  scope: SelectionScope;
  deep: boolean;
  readOnly: boolean;
  enabled: boolean;
  view: CanvasView;
}) {
  const prefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [outlines, setOutlines] = useState<readonly HoverOutline[]>([]);
  const selection = useMemo(() => new Set(selectedIds), [selectedIds]);
  const source = useRef<Source>({ kind: "none" });
  const geometry = useMemo(() => createHoverGeometry(), []);
  const frame = useRef<number | null>(null);
  const dirty = useRef(true);
  const rehit = useRef(false);
  const measuredId = useRef<string | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const observedElements = useRef<ReadonlySet<HTMLElement>>(new Set());

  const clear = useEditorEvent(() => {
    if (measuredId.current === null && observedElements.current.size === 0) return;
    measuredId.current = null;
    observer.current?.disconnect();
    observedElements.current = new Set();
    setOutlines((current) => (current.length ? [] : current));
  });

  const measure = useEditorEvent(() => {
    const canvas = viewport.current;
    let input = source.current;
    if (!canvas || !enabled || input.kind === "pressed" || input.kind === "none") {
      clear();
      return;
    }
    if (rehit.current && input.kind === "canvas") {
      const hit = document.elementFromPoint(input.x, input.y);
      input = {
        ...input,
        hitId:
          hit && canvas.contains(hit) && !hit.closest("[data-canvas-control]")
            ? (hit.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId ?? null)
            : null,
      };
      source.current = input;
    }
    rehit.current = false;
    const target = canvasSelectionTarget({
      hitId: input.kind === "layer" ? input.id : input.hitId,
      nodes,
      scope,
      deep: input.kind === "layer" || input.direct || deep,
      readOnly: input.kind === "layer" || readOnly,
    });
    if (!target) {
      clear();
      return;
    }
    if (measuredId.current === target.id && !dirty.current) return;
    dirty.current = false;
    measuredId.current = target.id;
    const registry = canvasElements(canvas);
    const element = registry.get(target.id);
    if (!element || !element.isConnected) {
      clear();
      return;
    }

    const { outlines: next, observed } = geometry.measure({
      canvas,
      target,
      children: hoverChildren(target, childrenById),
      registry,
      view,
    });
    for (const element of observedElements.current)
      if (!observed.has(element)) observer.current?.unobserve(element);
    for (const element of observed)
      if (!observedElements.current.has(element)) observer.current?.observe(element);
    observedElements.current = observed;
    setOutlines(next);
  });

  const schedule = useEditorEvent((invalidate = false) => {
    if (invalidate) dirty.current = true;
    if (!enabled || source.current.kind === "pressed" || source.current.kind === "none") {
      clear();
      return;
    }
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      measure();
    });
  });

  useImperativeHandle(ref, () => ({
    previewLayer(id) {
      source.current = id ? { kind: "layer", id } : { kind: "none" };
      schedule(true);
    },
  }));

  // Re-hit-test after layout changes, even if the pointer has not moved.
  const refresh = useEditorEvent(() => {
    geometry.clear();
    rehit.current = true;
    schedule(true);
  });

  useLayoutEffect(refresh, [nodes, childrenById, refresh]);
  useLayoutEffect(() => {
    rehit.current = true;
    schedule(true);
  }, [scope, selection, enabled, deep, readOnly, view, schedule]);

  // The viewport ref belongs to our parent; subscribe after its ref is attached.
  useEffect(() => {
    const canvas = viewport.current;
    if (!canvas) return;
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerType === "touch" || event.buttons) return;
      rehit.current = false;
      const hit = event.target;
      source.current = {
        kind: "canvas",
        x: event.clientX,
        y: event.clientY,
        hitId:
          hit instanceof Element && !hit.closest("[data-canvas-control]")
            ? (hit.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId ?? null)
            : null,
        direct: event.metaKey || event.ctrlKey,
      };
      schedule();
    };
    const leave = () => {
      source.current = { kind: "none" };
      clear();
    };
    const down = () => {
      source.current = { kind: "pressed" };
      clear();
    };
    const up = (event: globalThis.PointerEvent) => {
      if (source.current.kind !== "pressed") return;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      if (!hit || !canvas.contains(hit)) {
        leave();
        return;
      }
      source.current = {
        kind: "canvas",
        x: event.clientX,
        y: event.clientY,
        hitId: null,
        direct: event.metaKey || event.ctrlKey,
      };
      rehit.current = true;
      schedule(true);
    };
    const blur = leave;
    const visibility = () => {
      if (document.hidden) blur();
    };
    const modifier = (event: globalThis.KeyboardEvent) => {
      const input = source.current;
      if (input.kind !== "canvas") return;
      const direct = event.metaKey || event.ctrlKey;
      if (input.direct === direct) return;
      source.current = { ...input, direct };
      schedule(true);
    };
    const sizes = new WeakMap<Element, { width: number; height: number }>();
    observer.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const previous = sizes.get(entry.target);
        const { width, height } = entry.contentRect;
        if (previous && (previous.width !== width || previous.height !== height)) changed = true;
        sizes.set(entry.target, { width, height });
      }
      if (changed) refresh();
    });
    canvas.addEventListener("pointermove", move, { passive: true });
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("pointerdown", down, true);
    canvas.addEventListener("scroll", refresh, true);
    canvas.addEventListener("load", refresh, true);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", modifier);
    window.addEventListener("keyup", modifier);
    document.fonts.addEventListener("loadingdone", refresh);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      observer.current?.disconnect();
      observedElements.current = new Set();
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("pointerdown", down, true);
      canvas.removeEventListener("scroll", refresh, true);
      canvas.removeEventListener("load", refresh, true);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", modifier);
      window.removeEventListener("keyup", modifier);
      document.fonts.removeEventListener("loadingdone", refresh);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [viewport, clear, refresh, schedule]);

  const renderedOutlines = useMemo(() => {
    const clips = new Map<string, string>();
    const root: ClipGroup = { outlines: [], children: new Map() };
    for (const outline of outlines) {
      if (selection.has(outline.id)) continue;
      let group = root;
      for (let index = outline.clips.length - 1; index >= 0; index--) {
        const points = outline.clips[index];
        if (!clips.has(points)) clips.set(points, `${prefix}-${clips.size}`);
        let child = group.children.get(points);
        if (!child) {
          child = { outlines: [], children: new Map() };
          group.children.set(points, child);
        }
        group = child;
      }
      group.outlines.push(outline);
    }
    if (!root.outlines.length && !root.children.size) return null;
    function render(group: ClipGroup): ReactNode {
      return (
        <>
          {group.outlines.map((outline) => (
            <polygon
              key={outline.id}
              data-hover-node-id={outline.id}
              data-hover-kind={outline.kind}
              points={outline.points}
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              strokeDasharray={outline.kind === "child" ? "3 3" : undefined}
              opacity={outline.kind === "child" ? 0.45 : 1}
            />
          ))}
          {Array.from(group.children, ([points, child]) => (
            <g key={points} clipPath={`url(#${clips.get(points)})`}>
              {render(child)}
            </g>
          ))}
        </>
      );
    }
    return (
      <>
        <defs>
          {Array.from(clips, ([points, id]) => (
            <clipPath key={id} id={id}>
              <polygon points={points} />
            </clipPath>
          ))}
        </defs>
        {render(root)}
      </>
    );
  }, [outlines, selection, prefix]);

  return (
    <svg
      aria-hidden="true"
      data-canvas-hover
      className="pointer-events-none absolute inset-0 h-full w-full overflow-hidden"
      style={{ color: "var(--color-canvas-highlight)" }}
    >
      <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>{renderedOutlines}</g>
    </svg>
  );
}
