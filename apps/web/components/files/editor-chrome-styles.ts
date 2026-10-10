import type { EditorToolbarPlacement } from "@/lib/editor-preferences";

export const minimisedFileBarClass =
  "fixed left-3 top-4 z-20 flex max-w-[calc(100%-1.5rem)] min-w-0 items-center gap-2 rounded-lg border border-primary-grey/65 bg-primary-white/95 p-1.5 shadow-sm";

export function minimisedToolbarClass(placement: EditorToolbarPlacement) {
  const position =
    placement === "bottom"
      ? "absolute bottom-5 left-1/2 w-max max-w-[calc(100%-9rem)] -translate-x-1/2"
      : "fixed left-3 top-1/2 -translate-y-1/2";
  return `${position} z-20 rounded-lg border border-primary-grey/65 bg-primary-white/95 p-1.5 shadow-sm`;
}

export function canvasToolsClass(horizontal: boolean) {
  return `group/toolbar flex items-center gap-1 ${horizontal ? "flex-wrap justify-center" : "flex-col"}`;
}
