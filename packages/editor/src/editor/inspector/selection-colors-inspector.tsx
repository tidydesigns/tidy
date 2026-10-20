"use client";
import { useMemo, useState } from "react";
import type { DesignDocument, DesignNode } from "../../design/document";
import { resolvedColorTokens } from "../../design/design-tokens";
import { replaceSelectionColor } from "../../design/selection-colors";
import { nodeIndex } from "../../design/node-index";
import {
  createColourPalette,
  reconcileColourPalette,
  recolourPalette,
  indexSelectionColours,
} from "./selection-colour-palette";
import { applyColor, ColorField, Section } from "../inspector-controls";

export function SelectionColorsInspector({
  selected,
  document,
  onDocument,
}: {
  selected: DesignNode[];
  document: DesignDocument;
  onDocument: (transform: (document: DesignDocument) => DesignDocument) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [all, setAll] = useState(false);
  const { nodes, tokens, colours, groups } = useMemo(() => {
    const byId = nodeIndex(document.nodes);
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
    const tokens = resolvedColorTokens({
      tokens: document.tokens,
      designTokens: document.designTokens,
    });
    const groups = indexSelectionColours(nodes, tokens);
    return { nodes, tokens, colours: [...groups.keys()], groups };
  }, [document.nodes, document.tokens, document.designTokens, selected]);
  const [palette, setPalette] = useState(() => createColourPalette(colours));
  const currentPalette = reconcileColourPalette(palette, colours);
  if (currentPalette !== palette) setPalette(currentPalette);
  const rows = currentPalette.rows;
  if ((!editing && colours.length < 2) || (selected.length === 1 && nodes.length === 1))
    return null;
  return (
    <Section title="Selection colours" replayTitle>
      <div className={all ? "max-h-64 space-y-2 overflow-y-auto overscroll-contain" : "space-y-2"}>
        {(all ? rows : rows.slice(0, 4)).map(({ colour, id }) => {
          const matching = groups.get(colour) ?? [];
          const matchingIds = new Set(matching.map((node) => node.id));
          return (
            <ColorField
              key={id}
              onOpenChange={setEditing}
              compact
              label={`Selection colour ${colour}`}
              nodes={matching}
              get={() => colour}
              onChange={(change) => {
                const next = applyColor(change, colour);
                setPalette((previous) => recolourPalette(previous, id, next));
                onDocument((content) => ({
                  ...content,
                  nodes: content.nodes.map((node) => {
                    if (!matchingIds.has(node.id)) return node;
                    const next = applyColor(change, colour);
                    return replaceSelectionColor({ node, tokens, colour, next });
                  }),
                }));
              }}
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
