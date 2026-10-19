"use client";

import { useLayoutEffect, type RefObject } from "react";
import type { DesignNode } from "../design/document";
import { canvasElements } from "./canvas-elements";

/** React owns outline visibility; only selected nodes need camera-dependent widths.
 * Keeping zoom off the artwork ancestor avoids invalidating every descendant's style. */
export function useSelectionOutlineScale({
  viewport,
  selectedIds,
  zoom,
  nodes,
}: {
  viewport: RefObject<HTMLElement | null>;
  selectedIds: readonly string[];
  zoom: number;
  nodes: ReadonlyMap<string, DesignNode>;
}) {
  useLayoutEffect(() => {
    const elements = canvasElements(viewport.current);
    for (const id of selectedIds) {
      const element = elements.get(id);
      if (!element) continue;
      element.style.outlineWidth = `${2 / zoom}px`;
      element.style.outlineOffset = `${1 / zoom}px`;
    }
    // Node changes can replace a selected DOM element without changing selection or zoom.
  }, [viewport, selectedIds, zoom, nodes]);
}
