"use client";

import { useEditorPanelsOpen } from "@/components/ui/editor-panel-preference";
import { useEditorToolbarPlacement } from "@/components/ui/editor-toolbar-preference";
import type { EditorToolbarPlacement } from "@/lib/editor-preferences";
import {
  canvasToolsClass,
  minimisedFileBarClass,
  minimisedToolbarClass,
} from "./editor-chrome-styles";

export type EditorSkeletonPreferences = {
  initialPanelsOpen?: boolean;
  initialToolbarPlacement?: EditorToolbarPlacement;
};

function Tools({ horizontal = false }: { horizontal?: boolean }) {
  return (
    <div
      data-skeleton-tools
      data-orientation={horizontal ? "horizontal" : "vertical"}
      className={canvasToolsClass(horizontal)}
    >
      {Array.from({ length: 10 }, (_, tool) => (
        <div
          key={tool}
          className={`${tool === 5 ? "size-9" : "size-10"} shrink-0 rounded-lg bg-subtle-fill motion-safe:animate-pulse`}
        />
      ))}
    </div>
  );
}

export function EditorSkeleton({
  initialPanelsOpen = false,
  initialToolbarPlacement = "left",
}: EditorSkeletonPreferences = {}) {
  const panelsOpen = useEditorPanelsOpen(initialPanelsOpen);
  const placement = useEditorToolbarPlacement(initialToolbarPlacement);
  return (
    <main
      role="status"
      aria-label="Loading file"
      data-page-skeleton="editor"
      className="relative flex h-dvh w-full overflow-hidden bg-canvas"
    >
      <span className="sr-only">Loading file…</span>
      {panelsOpen && (
        <div aria-hidden="true" className="flex shrink-0">
          <div className="flex w-64 flex-col border-r border-primary-grey/70 bg-primary-white">
            <div className="flex h-16 shrink-0 items-center gap-2 border-b border-primary-grey/70 px-3">
              <div className="size-8 shrink-0 rounded-lg bg-subtle-fill motion-safe:animate-pulse" />
              <div className="h-4 flex-1 rounded bg-subtle-fill motion-safe:animate-pulse" />
              <div className="size-10 shrink-0 rounded-lg bg-subtle-fill motion-safe:animate-pulse" />
            </div>
            <div className="flex h-[45px] shrink-0 items-center gap-1 border-b border-primary-grey/60 px-3">
              <div className="h-7 w-16 rounded-md bg-subtle-fill motion-safe:animate-pulse" />
              <div className="h-7 w-16 rounded-md bg-subtle-fill motion-safe:animate-pulse" />
            </div>
            <div className="space-y-4 p-3">
              {Array.from({ length: 8 }, (_, row) => (
                <div key={row} className="h-4 rounded bg-subtle-fill motion-safe:animate-pulse" />
              ))}
            </div>
          </div>
          <div className="w-[53px] border-r border-primary-grey/70 bg-primary-white px-1.5 py-3">
            <Tools />
          </div>
        </div>
      )}
      <div aria-hidden="true" className="relative min-w-0 flex-1">
        {!panelsOpen && (
          <>
            <div data-skeleton-file-bar className={minimisedFileBarClass}>
              <div className="size-10 shrink-0 rounded-lg bg-subtle-fill motion-safe:animate-pulse" />
              <div className="h-6 w-px shrink-0 bg-primary-grey/65" />
              <div className="mx-2 h-4 w-28 rounded bg-subtle-fill motion-safe:animate-pulse" />
              <div className="size-10 shrink-0 rounded-lg bg-subtle-fill motion-safe:animate-pulse" />
            </div>
            <div className={minimisedToolbarClass(placement)}>
              <Tools horizontal={placement === "bottom"} />
            </div>
          </>
        )}
        <div
          data-skeleton-zoom
          className="absolute right-4 top-4 flex h-8 items-center gap-2 rounded-md border border-primary-grey/80 bg-surface px-2.5"
        >
          <div className="h-3 w-7 rounded bg-subtle-fill motion-safe:animate-pulse" />
          <div className="size-2.5 rounded bg-subtle-fill motion-safe:animate-pulse" />
        </div>
      </div>
      <div
        aria-hidden="true"
        className={`absolute size-10 rounded-lg border border-primary-grey/70 bg-primary-white shadow-sm ${panelsOpen ? "bottom-3 left-3" : "bottom-5 left-4"}`}
      />
    </main>
  );
}
