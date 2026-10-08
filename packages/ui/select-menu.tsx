"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export type SelectMenuOption = { value: string; label: string; disabled?: boolean };

export function SelectMenu({
  value,
  options,
  onChange,
  label,
  labelledBy,
  disabled = false,
  className = "",
  placement = "bottom",
  size = "default",
  triggerContent,
  triggerClassName,
  actionMenu = false,
}: {
  triggerContent?: ReactNode;
  triggerClassName?: string;
  actionMenu?: boolean;
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  label: string;
  labelledBy?: string;
  disabled?: boolean;
  className?: string;
  placement?: "top" | "bottom";
  size?: "default" | "sm";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const valueId = useId();
  const menuId = useId();
  const selected = options.find((option) => option.value === value);
  const unavailable = disabled || !options.some((option) => !option.disabled);
  const visible = open && !unavailable;

  useLayoutEffect(() => {
    if (!visible || !menu.current || !trigger.current) return;
    const popup = menu.current;
    const anchor = trigger.current;
    popup.showPopover();
    function position(event?: Event) {
      if (event?.target instanceof Node && popup.contains(event.target)) return;
      const bounds = anchor.getBoundingClientRect();
      const margin = 8,
        gap = 6;
      popup.style.minWidth = `${Math.min(bounds.width, window.innerWidth - margin * 2)}px`;
      const height = Math.min(256, popup.scrollHeight + 2);
      const below = window.innerHeight - bounds.bottom - gap - margin;
      const above = bounds.top - gap - margin;
      const useTop =
        placement === "top" ? above >= height || above > below : below < height && above > below;
      popup.style.maxHeight = `${Math.max(0, Math.min(256, useTop ? above : below))}px`;
      const size = popup.getBoundingClientRect();
      popup.style.left = `${Math.max(margin, Math.min(placement === "top" ? bounds.right - size.width : bounds.left, window.innerWidth - size.width - margin))}px`;
      const top = useTop ? bounds.top - gap - size.height : bounds.bottom + gap;
      popup.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - size.height - margin))}px`;
    }
    position();
    const active =
      popup.querySelector<HTMLButtonElement>(
        '[role="menuitemradio"][aria-checked="true"]:not(:disabled)',
      ) ?? popup.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)');
    active?.focus({ preventScroll: true });
    if (active)
      popup.scrollTop = Math.max(0, active.offsetTop + active.offsetHeight - popup.clientHeight);
    document.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      document.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
      if (popup.matches(":popover-open")) popup.hidePopover();
    };
  }, [visible, placement]);

  useEffect(() => {
    if (!visible) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [visible]);

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      trigger.current?.focus();
      setOpen(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role^="menuitem"]:not(:disabled)',
      ),
    ];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <div
      ref={root}
      className={`relative min-w-0 ${className}`}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        ref={trigger}
        type="button"
        disabled={unavailable}
        aria-label={
          labelledBy ? undefined : actionMenu ? label : `${label}: ${selected?.label ?? value}`
        }
        aria-labelledby={labelledBy ? `${labelledBy} ${valueId}` : undefined}
        aria-haspopup="menu"
        aria-expanded={visible}
        aria-controls={visible ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={
          triggerClassName ??
          `flex w-full items-center justify-between gap-2 border bg-surface text-left font-normal text-primary-black hover:border-primary-black/40 focus-visible:outline-2 focus-visible:outline-primary-orange disabled:opacity-50 ${size === "sm" ? "h-8 rounded-md border-primary-grey/70 px-2 text-xs" : "min-h-10 rounded-lg border-primary-grey px-3 text-sm"}`
        }
      >
        {triggerContent ?? (
          <>
            <span id={valueId} className="truncate">
              {selected?.label ?? value}
            </span>
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              className="shrink-0 text-secondary-ink"
            >
              <path
                d="m3.5 6 4.5 4 4.5-4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </>
        )}
      </button>
      {visible && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          popover="manual"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className="fixed inset-auto z-50 m-0 max-h-64 w-max max-w-[min(28rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain rounded-xl border border-primary-grey bg-surface p-1 text-primary-black shadow-xl"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role={actionMenu ? "menuitem" : "menuitemradio"}
              aria-checked={actionMenu ? undefined : value === option.value}
              disabled={option.disabled}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                if (actionMenu || option.value !== value) onChange(option.value);
              }}
              className={`flex min-h-9 w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left text-sm font-normal enabled:hover:bg-primary-grey/20 focus-visible:bg-primary-grey/20 focus-visible:outline-none disabled:opacity-50 ${value === option.value ? "bg-primary-grey/20" : ""}`}
            >
              <span className="min-w-0 truncate">{option.label}</span>
              <span aria-hidden="true" className="w-4 shrink-0 text-accent-ink">
                {!actionMenu && value === option.value ? "✓" : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
