"use client";
import { useMemo, useState } from "react";
import type { DesignDocument, DesignNode } from "../design/document";
import { resolvedColorTokens } from "../design/design-tokens";
import { replaceSelectionColor, selectionColors } from "../design/selection-colors";
import { applyColor, ColorField, Section } from "./inspector-controls";

export function SelectionColorsInspector({
  selected,
  document,
  onDocument,
}: {
  selected: DesignNode[];
  document: DesignDocument;
  onDocument: (transform: (document: DesignDocument) => DesignDocument) => void;
}) {
  const [all, setAll] = useState(false);
  const { nodes, tokens, colours } = useMemo(() => {
    const byId = new Map(document.nodes.map((node) => [node.id, node]));
    const children = new Map<string, DesignNode[]>();
    for (const node of document.nodes) {
      if (!node.parentId) continue;
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
    const nodes: DesignNode[] = [];
    const visited = new Set<string>();
    const pending = selected.filter((node) => {
      let current: DesignNode | undefined = byId.get(node.id);
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        if (current.locked || !current.visible) return false;
        seen.add(current.id);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return true;
    });
    while (pending.length) {
      const node = pending.pop();
      if (!node || visited.has(node.id) || node.locked || !node.visible) continue;
      visited.add(node.id);
      nodes.push(node);
      pending.push(...(children.get(node.id) ?? []));
    }
    const tokens = resolvedColorTokens(document);
    return { nodes, tokens, colours: selectionColors(nodes, tokens) };
  }, [document, selected]);
  if (colours.length < 2 || (selected.length === 1 && nodes.length === 1)) return null;
  return (
    <Section title="Selection colours" replayTitle>
      <div className={all ? "max-h-64 space-y-2 overflow-y-auto overscroll-contain" : "space-y-2"}>
        {(all ? colours : colours.slice(0, 4)).map((colour) => {
          const matching = nodes.filter((node) => selectionColors([node], tokens).includes(colour));
          const matchingIds = new Set(matching.map((node) => node.id));
          return (
            <ColorField
              key={colour}
              compact
              label={`Selection colour ${colour}`}
              nodes={matching}
              get={() => colour}
              onChange={(change) =>
                onDocument((content) => ({
                  ...content,
                  nodes: content.nodes.map((node) => {
                    if (!matchingIds.has(node.id)) return node;
                    const next = applyColor(change, colour);
                    return replaceSelectionColor({ node, tokens, colour, next });
                  }),
                }))
              }
            />
          );
        })}
      </div>
      {colours.length > 4 && (
        <button
          type="button"
          className="text-[11px] text-secondary-ink hover:text-primary-black focus-visible:outline-2 focus-visible:outline-primary-orange"
          onClick={() => setAll(!all)}
        >
          {all ? "Show fewer colours" : `Show all ${colours.length} colours`}
        </button>
      )}
    </Section>
  );
}
