"use client";
import { useEditorHost } from "./host";
import type { RefObject } from "react";
export function useEditorPerformance(
  viewport: RefObject<HTMLElement | null>,
  count: number,
  panels: boolean,
  selection: boolean,
) {
  const { usePerformance } = useEditorHost();
  usePerformance(viewport, count, panels, selection);
}
