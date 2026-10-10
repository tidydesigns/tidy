"use client";

import {
  memo,
  useMemo,
  useState,
  type MouseEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useLayerWindow } from "./use-layer-window";
import type { DesignNode } from "@/lib/design/document";

type DropPosition = "before" | "inside" | "after";
export const LayerTree = memo(function LayerTree({
  nodes,
  selectedIds,
  query,
  onSelect,
  onMenu,
  onMove,
  onVisibility,
  onLock,
  readOnly = false,
}: {
  readOnly?: boolean;
  nodes: DesignNode[];
  selectedIds: string[];
  query: string;
  onSelect: (id: string, additive: boolean) => void;
  onMenu: (event: MouseEvent<HTMLElement>, id: string) => void;
  onMove: (id: string, target: string, position: DropPosition) => void;
  onVisibility: (id: string) => void;
  onLock: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragged, setDragged] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; position: DropPosition } | null>(null);
  const { children, byId } = useMemo(() => {
    const children = new Map<string | null, DesignNode[]>();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
      const siblings = children.get(node.parentId);
      if (siblings) siblings.push(node);
      else children.set(node.parentId, [node]);
    }
    return { children, byId };
  }, [nodes]);
  const selection = new Set(selectedIds);
  const rows = useMemo(() => {
    const matching = new Set<string>();
    if (query)
      for (const node of nodes) {
        if (!`${node.name} ${node.sourcePath ?? ""}`.toLowerCase().includes(query.toLowerCase()))
          continue;
        matching.add(node.id);
        let parent = node.parentId;
        while (parent) {
          matching.add(parent);
          parent = byId.get(parent)?.parentId ?? null;
        }
      }
    const result: LayerRowData[] = [];
    function collect(
      node: DesignNode,
      depth: number,
      parentLocked: boolean,
      parentVisible: boolean,
      index: number,
      siblings: number,
    ) {
      if (query && !matching.has(node.id)) return;
      const locked = parentLocked || node.locked,
        visible = parentVisible && node.visible;
      const nested = children.get(node.id) ?? [],
        expanded = query ? true : !collapsed.has(node.id);
      result.push({
        node,
        depth,
        parentLocked,
        locked,
        visible,
        nested,
        expanded,
        index,
        siblings,
      });
      if (expanded)
        nested.forEach((child, index) =>
          collect(child, depth + 1, locked, visible, index, nested.length),
        );
    }
    const roots = children.get(null) ?? [];
    roots.forEach((node, index) => collect(node, 0, false, true, index, roots.length));
    return result;
  }, [nodes, children, byId, query, collapsed]);
  const { tree, start, end, virtual, rowHeight } = useLayerWindow(
    rows.length,
    rows.findIndex((row) => row.node.id === selectedIds.at(-1)),
  );

  return (
    <div
      ref={tree}
      role="tree"
      aria-label="Layers"
      style={virtual ? { position: "relative", height: rows.length * rowHeight } : undefined}
    >
      {rows.slice(start, end).map((item, index) => (
        <LayerRow
          key={item.node.id}
          row={item}
          position={start + index}
          virtual={virtual}
          rowHeight={rowHeight}
          selected={selection.has(item.node.id)}
          readOnly={readOnly}
          dragged={dragged}
          drop={drop}
          setDragged={setDragged}
          setDrop={setDrop}
          setCollapsed={setCollapsed}
          onSelect={onSelect}
          onMenu={onMenu}
          onMove={onMove}
          onVisibility={onVisibility}
          onLock={onLock}
        />
      ))}
    </div>
  );
});

type LayerRowData = {
  node: DesignNode;
  depth: number;
  parentLocked: boolean;
  locked: boolean;
  visible: boolean;
  nested: DesignNode[];
  expanded: boolean;
  index: number;
  siblings: number;
};
type LayerRowProps = {
  row: LayerRowData;
  position: number;
  virtual: boolean;
  rowHeight: number;
  selected: boolean;
  readOnly: boolean;
  dragged: string | null;
  drop: { id: string; position: DropPosition } | null;
  setDragged: Dispatch<SetStateAction<string | null>>;
  setDrop: Dispatch<SetStateAction<{ id: string; position: DropPosition } | null>>;
  setCollapsed: Dispatch<SetStateAction<Set<string>>>;
  onSelect: (id: string, additive: boolean) => void;
  onMenu: (event: MouseEvent<HTMLElement>, id: string) => void;
  onMove: (id: string, target: string, position: DropPosition) => void;
  onVisibility: (id: string) => void;
  onLock: (id: string) => void;
};
const LayerRow = memo(function LayerRow({
  row: { node, depth, parentLocked, locked, visible, nested, expanded, index, siblings },
  position,
  virtual,
  rowHeight,
  selected,
  readOnly,
  dragged,
  drop,
  setDragged,
  setDrop,
  setCollapsed,
  onSelect,
  onMenu,
  onMove,
  onVisibility,
  onLock,
}: LayerRowProps) {
  const glyph = node.instanceOf
    ? "◇"
    : node.isComponent
      ? "◆"
      : node.type === "text"
        ? "T"
        : node.type === "image"
          ? "▧"
          : node.type === "artboard"
            ? "▣"
            : node.type === "vector"
              ? "◈"
              : "□";
  return (
    <div
      key={node.id}
      role="treeitem"
      aria-level={depth + 1}
      aria-posinset={index + 1}
      aria-setsize={siblings}
      style={
        virtual ? { position: "absolute", top: position * rowHeight, left: 0, right: 0 } : undefined
      }
      aria-selected={selected}
      aria-expanded={nested.length ? expanded : undefined}
    >
      <div
        draggable={!readOnly && !locked}
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-bella-layer", node.id);
          setDragged(node.id);
        }}
        onDragEnd={() => {
          setDragged(null);
          setDrop(null);
        }}
        onDragOver={(event) => {
          if (!dragged || dragged === node.id) return;
          event.preventDefault();
          event.stopPropagation();
          const scroller = event.currentTarget.closest<HTMLElement>('[role="tabpanel"]');
          if (scroller) {
            const bounds = scroller.getBoundingClientRect();
            if (event.clientY < bounds.top + 36) scroller.scrollTop -= 16;
            else if (event.clientY > bounds.bottom - 36) scroller.scrollTop += 16;
          }
          const bounds = event.currentTarget.getBoundingClientRect();
          const fraction = (event.clientY - bounds.top) / bounds.height;
          const position: DropPosition =
            fraction < 0.25
              ? "before"
              : fraction > 0.75
                ? "after"
                : ["artboard", "container"].includes(node.type)
                  ? "inside"
                  : "after";
          setDrop({ id: node.id, position });
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (dragged && drop?.id === node.id) onMove(dragged, node.id, drop.position);
          setDragged(null);
          setDrop(null);
        }}
        onContextMenu={(event) => onMenu(event, node.id)}
        className={`group relative flex h-8 items-center gap-1 rounded-md pr-1 text-xs ${selected ? "bg-primary-orange/10" : "hover:bg-primary-grey/20"} ${!visible ? "text-secondary-ink" : "text-primary-black/80"} ${drop?.id === node.id && drop.position === "inside" ? "ring-1 ring-inset ring-primary-orange/50" : ""}`}
        style={{ paddingLeft: 3 + depth * 14 }}
      >
        {drop?.id === node.id && drop.position !== "inside" && (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-x-0 h-px bg-primary-orange ${drop.position === "before" ? "top-0" : "bottom-0"}`}
          />
        )}
        {nested.length ? (
          <button
            type="button"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`}
            onClick={() =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(node.id)) next.delete(node.id);
                else next.add(node.id);
                return next;
              })
            }
            className="flex h-6 w-4 shrink-0 items-center justify-center rounded text-secondary-ink hover:bg-primary-grey/25 focus-visible:outline-2 focus-visible:outline-primary-orange"
          >
            {expanded ? "⌄" : "›"}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <button
          type="button"
          aria-label={`Select ${node.name}`}
          onClick={(event) => onSelect(node.id, event.shiftKey)}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-2 focus-visible:outline-primary-orange"
        >
          <span
            aria-hidden="true"
            className={`w-3 shrink-0 text-center ${node.isComponent || node.instanceOf ? "text-component-accent" : "text-secondary-ink"}`}
          >
            {glyph}
          </span>
          <span className="truncate">{node.name}</span>
        </button>
        <button
          type="button"
          disabled={readOnly || locked}
          aria-label={`${node.visible ? "Hide" : "Show"} ${node.name}`}
          onClick={() => onVisibility(node.id)}
          className={`h-6 w-5 shrink-0 rounded text-secondary-ink hover:bg-primary-grey/25 focus:opacity-100 ${node.visible ? "opacity-0 group-hover:opacity-100" : ""}`}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            width="14"
            height="14"
            className="mx-auto"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          >
            <path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" />
            <circle cx="10" cy="10" r="2" />
            {!node.visible && <path d="m3 3 14 14" />}
          </svg>
        </button>
        <button
          type="button"
          disabled={readOnly || parentLocked}
          aria-label={`${node.locked ? "Unlock" : "Lock"} ${node.name}`}
          onClick={() => onLock(node.id)}
          className={`h-6 w-5 shrink-0 rounded text-secondary-ink hover:bg-primary-grey/25 focus:opacity-100 ${node.locked ? "" : "opacity-0 group-hover:opacity-100"}`}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            width="14"
            height="14"
            className="mx-auto"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          >
            <rect x="4.5" y="8.5" width="11" height="8" rx="1.5" />
            <path
              d={node.locked ? "M6.5 8.5V6a3.5 3.5 0 0 1 7 0v2.5" : "M6.5 8.5V6a3.5 3.5 0 0 1 7 0"}
            />
          </svg>
        </button>
      </div>
    </div>
  );
});
