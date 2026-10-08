"use client";

import { useEffect, useRef } from "react";

export type LayerMenuItem = {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
};

export function layerMenuPosition(x: number, y: number, itemCount: number) {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - 232)),
    y: Math.max(8, Math.min(y, window.innerHeight - itemCount * 40 - 24)),
  };
}

export function LayerContextMenu({
  x,
  y,
  items,
  onClose,
  label = "Layer actions",
}: {
  x: number;
  y: number;
  items: LayerMenuItem[];
  onClose: () => void;
  label?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus({ preventScroll: true });
    function onPointerDown(event: globalThis.PointerEvent) {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      className="fixed z-50 max-h-[calc(100dvh-16px)] w-56 overflow-y-auto rounded-xl border border-primary-grey/70 bg-primary-white p-1.5 text-sm text-primary-black shadow-xl"
      style={{ left: x, top: y }}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        ];
        if (!buttons.length) return;
        event.preventDefault();
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
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left outline-none hover:bg-primary-grey/25 focus-visible:bg-primary-grey/25 disabled:cursor-not-allowed disabled:opacity-40 ${item.danger ? "text-danger" : ""}`}
        >
          <span>{item.label}</span>
          {item.shortcut && (
            <span aria-hidden="true" className="ml-3 text-xs text-secondary-ink">
              {item.shortcut}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
