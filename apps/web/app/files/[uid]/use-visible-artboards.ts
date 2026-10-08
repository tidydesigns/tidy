"use client";
import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from "react";
import type { DesignNode } from "@/lib/design/document";
import type { PresenceStore } from "@/lib/realtime/presence-store";
import { visibleCanvasRoots, type CanvasView } from "@/lib/design/canvas-culling";
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
export function useVisibleArtboards(
  nodes: DesignNode[],
  view: CanvasView,
  viewport: RefObject<HTMLDivElement | null>,
  selectedIds: string[],
  store: PresenceStore,
) {
  const [size, setSize] = useState({ width: 1200, height: 900 });
  const [select] = useState(visibilitySelector);
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
  return select(visibleCanvasRoots(nodes, view, size, pinned));
}
