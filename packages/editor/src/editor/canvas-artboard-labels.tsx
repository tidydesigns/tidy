"use client";

import { memo, useRef, useState } from "react";
import type { DesignNode } from "../design/document";

type Props = {
  nodesById: ReadonlyMap<string, DesignNode>;
  visibleRootIds: ReadonlySet<string>;
  selectedIds: readonly string[];
  readOnly: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onRename: (id: string, name: string) => void;
};

/** Editor chrome shares the node's identity, but never becomes part of the artwork. */
export const CanvasArtboardLabels = memo(function CanvasArtboardLabels({
  nodesById,
  visibleRootIds,
  selectedIds,
  readOnly,
  onSelect,
  onRename,
}: Props) {
  const selected = new Set(selectedIds);
  return Array.from(visibleRootIds, (id) => {
    const node = nodesById.get(id);
    return node?.parentId === null && node.type === "artboard" && node.visible ? (
      <ArtboardLabel
        key={node.id}
        node={node}
        selected={selected.has(node.id)}
        readOnly={readOnly}
        onSelect={onSelect}
        onRename={onRename}
      />
    ) : null;
  });
});

const ArtboardLabel = memo(function ArtboardLabel({
  node,
  selected,
  readOnly,
  onSelect,
  onRename,
}: Pick<Props, "readOnly" | "onSelect" | "onRename"> & {
  node: DesignNode;
  selected: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const canRename = !readOnly && !node.locked && !node.librarySource;
  const editing = draft !== null && canRename;
  const angle = ((node.style.rotation ?? 0) * Math.PI) / 180;
  const width =
    Math.abs(Math.cos(angle)) * node.box.width + Math.abs(Math.sin(angle)) * node.box.height;
  const height =
    Math.abs(Math.sin(angle)) * node.box.width + Math.abs(Math.cos(angle)) * node.box.height;
  return (
    <div
      data-canvas-control
      data-artboard-label={node.id}
      className="absolute pointer-events-none"
      style={{
        left: node.box.x + (node.box.width - width) / 2,
        top: node.box.y + (node.box.height - height) / 2,
        width,
      }}
    >
      <div
        className="absolute bottom-0 left-0 origin-bottom-left pb-1.5 pointer-events-auto"
        style={{
          transform: "scale(calc(1 / var(--canvas-zoom, 1)))",
          width: "calc(100% * var(--canvas-zoom, 1))",
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {editing ? (
          <input
            autoFocus
            aria-label="Artboard name"
            maxLength={120}
            value={draft}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              const name = draft.trim();
              if (!cancelled.current && name && name !== node.name) onRename(node.id, name);
              cancelled.current = false;
              setDraft(null);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape") {
                cancelled.current = true;
                event.currentTarget.blur();
              } else if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="block h-6 w-full min-w-0 rounded border border-primary-orange bg-surface px-1 text-xs text-primary-ink outline-none"
          />
        ) : (
          <button
            type="button"
            aria-label={`Select artboard ${node.name}`}
            aria-pressed={selected}
            title={node.name}
            onClick={(event) => onSelect(node.id, event.shiftKey)}
            onDoubleClick={() => {
              if (canRename) setDraft(node.name);
            }}
            className={`block max-w-full truncate rounded px-1 py-1 text-left text-xs leading-4 hover:bg-primary-grey/25 focus-visible:outline-2 focus-visible:outline-primary-orange ${selected ? "text-primary-orange" : "text-secondary-ink"}`}
          >
            {node.name}
          </button>
        )}
      </div>
    </div>
  );
});
