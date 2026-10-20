"use client";

import { useEditorEvent } from "../use-editor-event";
import { selectionTranslationDelta, canReuseSelectionAncestors } from "../selection-translation";
import { nodeIndex } from "../../design/node-index";
import { selectedElements } from "../canvas-elements";

import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { DesignDocument, DesignNode } from "../../design/document";
import { renderedNodeBox } from "../../design/canvas-geometry";

/** The inspector shows actual geometry for fill, hug, and constrained layers. */
export function useRenderedSelection(
  nodes: DesignNode[],
  document: DesignDocument,
  viewport?: RefObject<HTMLDivElement | null>,
  byId: ReadonlyMap<string, DesignNode> = nodeIndex(document.nodes),
) {
  const [boxes, setBoxes] = useState<Record<string, DesignNode["box"]>>({});
  const measured = useRef<{
    nodes: DesignNode[];
    ancestors: DesignNode[];
    boxes: Record<string, DesignNode["box"]>;
  } | null>(null);
  const ancestry = useEditorEvent(() => {
    const parents = new Map<string, DesignNode>();
    for (const node of nodes) {
      let parent = byId.get(node.parentId ?? "");
      while (parent && !parents.has(parent.id)) {
        parents.set(parent.id, parent);
        parent = byId.get(parent.parentId ?? "");
      }
    }
    return [...parents.values()];
  });
  const elements = useEditorEvent(() =>
    selectedElements(
      viewport?.current,
      nodes.map((node) => node.id),
    ),
  );
  const selectionKey = JSON.stringify(nodes.map((node) => node.id));
  const ancestorKey = JSON.stringify(
    nodes.map((node) => {
      const ids: string[] = [];
      let parent = byId.get(node.parentId ?? "");
      while (parent) {
        ids.push(parent.id);
        parent = byId.get(parent.parentId ?? "");
      }
      return ids;
    }),
  );
  const measure = useEditorEvent(() => {
    const canvas = viewport?.current;
    if (!canvas) return;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const next: Record<string, DesignNode["box"]> = {};
    for (const element of elements()) {
      const id = element.dataset.nodeId;
      if (!id) continue;
      const actual = renderedNodeBox(element);
      const stored = byId.get(id)?.box;
      if (
        !stored ||
        actual.x !== stored.x ||
        actual.y !== stored.y ||
        actual.width !== stored.width ||
        actual.height !== stored.height
      )
        next[id] = actual;
    }
    measured.current = { nodes, ancestors: ancestry(), boxes: next };
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
  const update = useEditorEvent(() => {
    const previous = measured.current;
    const parents = ancestry();
    if (
      previous &&
      previous.nodes.length === nodes.length &&
      canReuseSelectionAncestors(parents) &&
      previous.ancestors.length === parents.length &&
      parents.every((parent, index) => parent === previous.ancestors[index])
    ) {
      const next: Record<string, DesignNode["box"]> = {};
      let translated = true;
      for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        const parent = byId.get(node.parentId ?? "");
        const delta = selectionTranslationDelta(previous.nodes[index], node);
        if (
          !delta ||
          (parent && parent.layout !== "absolute" && node.positionMode !== "absolute")
        ) {
          translated = false;
          break;
        }
        const box = previous.boxes[node.id];
        if (box) next[node.id] = { ...box, x: box.x + delta.x, y: box.y + delta.y };
      }
      if (translated) {
        measured.current = { nodes, ancestors: parents, boxes: next };
        if (Object.keys(next).length) setBoxes(next);
        return;
      }
    }
    measure();
  });
  useLayoutEffect(update, [nodes, document, update]);
  useLayoutEffect(() => {
    const canvas = viewport?.current;
    if (!canvas) return;
    const observer = new ResizeObserver(measure);
    for (const element of selectedElements(
      canvas,
      ancestry().map((node) => node.id),
    ))
      observer.observe(element);
    for (const element of elements()) {
      observer.observe(element);
      if (element.parentElement) observer.observe(element.parentElement);
    }
    return () => observer.disconnect();
  }, [selectionKey, ancestorKey, viewport, measure, elements, ancestry]);
  return useMemo(
    () => nodes.map((node) => (boxes[node.id] ? { ...node, box: boxes[node.id] } : node)),
    [nodes, boxes],
  );
}
