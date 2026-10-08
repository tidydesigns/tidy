"use client";

import { useEffect, useRef, useState } from "react";

export type CanvasPreferences = {
  centerSelection: boolean;
  numberKeys: boolean;
  invertZoom: boolean;
  rightClickPan: boolean;
  pixelGrid: boolean;
  snapPixels: boolean;
  snapObjects: boolean;
  guides: boolean;
  deepSelection: boolean;
  comments: boolean;
};

export function CanvasViewMenu({
  percent,
  hasSelection,
  preferences,
  nudgeStep,
  onNudgeStep,
  onToggle,
  onZoom,
}: {
  percent: number;
  hasSelection: boolean;
  preferences: CanvasPreferences;
  nudgeStep: number;
  onNudgeStep: (step: number) => void;
  onToggle: (key: keyof CanvasPreferences) => void;
  onZoom: (action: "in" | "out" | "actual" | "fit" | "selection") => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    function dismiss(event: globalThis.PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const row =
    "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-xs hover:bg-primary-grey/25 focus-visible:bg-primary-grey/25 focus-visible:outline-none disabled:opacity-40";
  const toggles: { key: keyof CanvasPreferences; label: string; shortcut?: string }[] = [
    { key: "centerSelection", label: "Zoom centers selection" },
    { key: "numberKeys", label: "Zoom using number keys" },
    { key: "invertZoom", label: "Invert zoom direction" },
    { key: "rightClickPan", label: "Right click to pan" },
    { key: "pixelGrid", label: "Show pixel grid", shortcut: "⇧'" },
    { key: "snapPixels", label: "Snap to pixel", shortcut: "⇧⌘'" },
    { key: "snapObjects", label: "Snap to objects" },
    { key: "guides", label: "Rulers and guides", shortcut: "⇧G" },
    { key: "deepSelection", label: "Use deep selection" },
    { key: "comments", label: "Show comments", shortcut: "⇧C" },
  ];
  return (
    <div ref={root} className="relative" data-canvas-control>
      <button
        ref={trigger}
        type="button"
        aria-label={`Zoom ${percent}%`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-8 items-center gap-2 rounded-md border border-primary-grey/80 bg-surface px-2.5 text-xs tabular-nums hover:bg-primary-grey/20"
      >
        {percent}%
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="m2 4 3 3 3-3" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Canvas view"
          className="absolute right-0 top-10 z-50 max-h-[calc(100dvh-72px)] w-64 overflow-y-auto rounded-xl border border-primary-grey/70 bg-primary-white p-1.5 shadow-xl"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
              return;
            }
            if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const buttons = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
            ];
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : event.key === "ArrowDown"
                    ? (current + 1) % buttons.length
                    : (current - 1 + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}
        >
          {(
            [
              { action: "in", label: "Zoom in", shortcut: "+" },
              { action: "out", label: "Zoom out", shortcut: "−" },
              { action: "actual", label: "Zoom to 100%", shortcut: "⇧0" },
              { action: "fit", label: "Zoom to fit", shortcut: "⇧1" },
              { action: "selection", label: "Zoom to selection", shortcut: "⇧2" },
            ] as const
          ).map(({ action, label, shortcut }) => (
            <button
              key={action}
              type="button"
              role="menuitem"
              disabled={action === "selection" && !hasSelection}
              className={row}
              onClick={() => {
                onZoom(action);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <span className="pl-4">{label}</span>
              <span className="text-secondary-ink">{shortcut}</span>
            </button>
          ))}
          {toggles.map(({ key, label, shortcut }, index) => (
            <div key={key}>
              {[0, 4, 8].includes(index) && (
                <div role="separator" className="mx-3 my-1.5 border-t border-primary-grey/70" />
              )}
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={preferences[key]}
                onClick={() => onToggle(key)}
                className={row}
                title={key === "pixelGrid" ? "Visible at 200% zoom and above" : undefined}
              >
                <span className="flex items-center gap-1">
                  <span aria-hidden="true" className="w-3">
                    {preferences[key] ? "✓" : ""}
                  </span>
                  {label}
                </span>
                {shortcut && <span className="text-secondary-ink">{shortcut}</span>}
              </button>
            </div>
          ))}
          <div role="separator" className="mx-3 my-1.5 border-t border-primary-grey/70" />
          <label className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
            Nudge step{" "}
            <span className="flex items-center gap-1">
              <input
                aria-label="Nudge step"
                type="number"
                min="1"
                max="100"
                step="1"
                value={nudgeStep}
                onChange={(event) => onNudgeStep(Number(event.target.value))}
                className="w-14 rounded-md border border-primary-grey/80 bg-surface px-1.5 py-1 text-right tabular-nums focus-visible:outline-2 focus-visible:outline-primary-orange"
              />
              px
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
