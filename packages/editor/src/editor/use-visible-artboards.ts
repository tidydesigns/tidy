"use client";
import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from "react";
import type { DesignNode } from "../design/document";
import type { PresenceStore } from "../lib/realtime/presence-store";
import { canvasElements } from "./canvas-elements";
import { nodeIndex } from "../design/node-index";
import { visibleCanvasRoots, type CanvasView } from "../design/canvas-culling";
function visibilitySelector() {
  let key = "",
    result = new Set<string>();
  return (ids: string[]) => {
    const next = JSON.stringify(ids);
    if (next !== key) {
      key = next;
      result = new Set(ids);
    }
    return result;
  };
}
function overflowBoundsStore() {
  const cache = new WeakMap<DesignNode[], ReadonlyMap<string, DesignNode["box"]>>();
  const listeners = new Set<() => void>();
  let version = 0;
  let previousBounds: ReadonlyMap<string, DesignNode["box"]> | undefined;
  const notify = () => {
    version++;
    for (const listener of listeners) listener();
  };
  return {
    cache,
    getSnapshot: () => version,
    getServerSnapshot: () => 0,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (nodes: DesignNode[], bounds: ReadonlyMap<string, DesignNode["box"]>) => {
      cache.set(nodes, bounds);
      const unchanged = previousBounds?.size === 0 && bounds.size === 0;
      previousBounds = bounds;
      if (!unchanged) notify();
    },
    invalidate: (nodes: DesignNode[]) => {
      cache.delete(nodes);
      notify();
    },
  };
}
export function useVisibleArtboards(
  nodes: DesignNode[],
  view: CanvasView,
  viewport: RefObject<HTMLDivElement | null>,
  selectedIds: string[],
  store: PresenceStore,
) {
  const [size, setSize] = useState({ width: 1200, height: 900 });
  const [select] = useState(visibilitySelector);
  const [boundsStore] = useState(overflowBoundsStore);
  const boundsCache = boundsStore.cache;
  const boundsVersion = useSyncExternalStore(
    boundsStore.subscribe,
    boundsStore.getSnapshot,
    boundsStore.getServerSnapshot,
  );
  useLayoutEffect(() => {
    const changed = () => {
      boundsStore.invalidate(nodes);
    };
    document.fonts.addEventListener("loadingdone", changed);
    return () => document.fonts.removeEventListener("loadingdone", changed);
  }, [nodes, boundsStore]);
  useLayoutEffect(() => {
    if (boundsCache.has(nodes) || !viewport.current) return;
    const canvas = viewport.current,
      origin = canvas.getBoundingClientRect(),
      byId = nodeIndex(nodes);
    const elements = canvasElements(canvas),
      bounds = new Map<string, DesignNode["box"]>();
    const effects = new Map<string, number>();
    const unbounded = new Set<string>();
    for (const node of nodes) {
      let root = node;
      while (root.parentId) {
        const parent = byId.get(root.parentId);
        if (!parent) break;
        root = parent;
      }
      if (node.style.shadow) unbounded.add(root.id);
      const shadows = node.style.shadows ?? [];
      const extra =
        (node.style.borderWidth ?? 0) +
        (node.style.blur ?? 0) * 6 +
        Math.max(
          0,
          ...shadows
            .filter((shadow) => shadow.visible && !shadow.inset)
            .map(
              (shadow) =>
                Math.abs(shadow.x) + Math.abs(shadow.y) + shadow.blur * 6 + Math.abs(shadow.spread),
            ),
        );
      effects.set(root.id, Math.max(effects.get(root.id) ?? 0, extra));
    }
    for (const node of nodes) {
      if (node.parentId || !node.visible) continue;
      // Clipped artboards already have deterministic model bounds. Free trees
      // need their rendered descendant/text bounds so overflowing content survives.
      if (
        node.type === "artboard" &&
        node.style.overflow !== "visible" &&
        node.style.overflow !== "auto" &&
        !node.style.shadow &&
        !node.style.shadows?.length &&
        !node.style.blur
      )
        continue;
      const element = elements.get(node.id);
      if (!element) continue;
      if (unbounded.has(node.id)) continue; // Unparsed legacy effects cannot be bounded here.
      const rect = element.getBoundingClientRect(),
        range = document.createRange();
      range.selectNodeContents(element);
      const content = range.getBoundingClientRect();
      const extra = (effects.get(node.id) ?? 0) + 32;
      const x =
        (Math.min(rect.left, content.width || content.height ? content.left : rect.left) -
          origin.left -
          view.x) /
          view.zoom -
        extra;
      const y =
        (Math.min(rect.top, content.width || content.height ? content.top : rect.top) -
          origin.top -
          view.y) /
          view.zoom -
        extra;
      const right =
        (Math.max(rect.right, content.width || content.height ? content.right : rect.right) -
          origin.left -
          view.x) /
          view.zoom +
        extra;
      const bottom =
        (Math.max(rect.bottom, content.width || content.height ? content.bottom : rect.bottom) -
          origin.top -
          view.y) /
          view.zoom +
        extra;
      bounds.set(node.id, { x, y, width: right - x, height: bottom - y });
    }
    boundsStore.publish(nodes, bounds);
  }, [nodes, view, viewport, boundsCache, boundsStore, boundsVersion]);
  const peers = useSyncExternalStore(
    store.subscribe,
    store.getDecorationsSnapshot,
    store.getServerSnapshot,
  );
  useLayoutEffect(() => {
    const canvas = viewport.current;
    if (!canvas) return;
    const measure = () =>
      setSize((old) =>
        old.width === canvas.clientWidth && old.height === canvas.clientHeight
          ? old
          : { width: canvas.clientWidth, height: canvas.clientHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [viewport]);
  const pinned = [
    ...selectedIds,
    ...peers.flatMap((peer) => [
      ...peer.selectedIds,
      ...(peer.preview?.nodeId ? [peer.preview.nodeId] : []),
    ]),
  ];
  return select(visibleCanvasRoots(nodes, view, size, pinned, boundsCache.get(nodes)));
}
