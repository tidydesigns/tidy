"use client";

import { useEditorEvent } from "./use-editor-event";
import { selectedElements } from "./canvas-elements";

import { useLayoutEffect, useState, type RefObject } from "react";
import type { DesignDocument, DesignNode } from "@/lib/design/document";
import { renderedNodeBox } from "@/lib/design/canvas-geometry";

/** The inspector shows actual geometry for fill, hug, and constrained layers. */
export function useRenderedSelection(
  nodes: DesignNode[],
  document: DesignDocument,
  viewport?: RefObject<HTMLDivElement | null>,
) {
  const [boxes, setBoxes] = useState<Record<string, DesignNode["box"]>>({});
  const selectionKey = JSON.stringify(nodes.map((node) => node.id));
  const measure = useEditorEvent(() => {
    const canvas = viewport?.current;
    if (!canvas) return;
    const elements = selectedElements(
      canvas,
      nodes.map((node) => node.id),
    );
    const next = Object.fromEntries(
      elements.map((element) => [element.dataset.nodeId!, renderedNodeBox(element)]),
    );
    setBoxes((current) => {
      const ids = Object.keys(next);
      return ids.length === Object.keys(current).length &&
        ids.every((id) => {
          const a = current[id],
            b = next[id];
          return a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
        })
        ? current
        : next;
    });
  });
  useLayoutEffect(measure, [nodes, document, measure]);
  useLayoutEffect(() => {
    const canvas = viewport?.current;
    if (!canvas) return;
    const elements = selectedElements(canvas, JSON.parse(selectionKey) as string[]);
    const observer = new ResizeObserver(measure);
    for (const element of elements) {
      observer.observe(element);
      if (element.parentElement) observer.observe(element.parentElement);
    }
    return () => observer.disconnect();
  }, [selectionKey, viewport, measure]);
  return nodes.map((node) => (boxes[node.id] ? { ...node, box: boxes[node.id] } : node));
}
