"use client";
import { textFontSegments } from "@bella/design/rich-text";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { DesignNode } from "../document";
import { fontRegistry } from "./runtime";
import { nodeIndex } from "../node-index";
export function useFontRegistry() {
  useSyncExternalStore(fontRegistry.subscribe, fontRegistry.snapshot, fontRegistry.serverSnapshot);
  return fontRegistry;
}
export function useDocumentFonts(nodes?: DesignNode[], visibleRoots?: ReadonlySet<string>) {
  const requests = useMemo(() => {
    const byId = nodeIndex(nodes ?? []),
      visibility = new Map<string, boolean>();
    function visible(node: DesignNode): boolean {
      const cached = visibility.get(node.id);
      if (cached !== undefined) return cached;
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      const result =
        node.visible && (parent ? visible(parent) : !visibleRoots || visibleRoots.has(node.id));
      visibility.set(node.id, result);
      return result;
    }
    const groups = new Map<string, Set<string>>();
    for (const node of nodes ?? []) {
      if (node.type !== "text" || !visible(node)) continue;
      for (const segment of textFontSegments({ ...node, text: node.text ?? "" })) {
        const key = JSON.stringify([
          node.style.fontFamily ?? "system-ui",
          segment.weight,
          segment.italic,
          node.style.fontSource,
          segment.face,
        ]);
        const characters = groups.get(key) ?? new Set<string>();
        for (const character of segment.text) characters.add(character);
        groups.set(key, characters);
      }
    }
    return JSON.stringify(
      [...groups].map(([key, characters]) => [JSON.parse(key), [...characters].sort().join("")]),
    );
  }, [nodes, visibleRoots]);
  useEffect(() => {
    type Face = [
      string,
      number,
      boolean,
      "web" | "local" | "system" | undefined,
      string | undefined,
    ];
    const values = JSON.parse(requests) as [Face, string][];
    const release = fontRegistry.retainFamilies(values.map(([face]) => face[0]));
    for (const [[family, weight, italic, source, face], text] of values)
      void fontRegistry.load(family, weight, italic, text, source ?? undefined, face ?? undefined);
    return release;
  }, [requests]);
}
