"use client";

import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export type SelectMenuOption = {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
  checked?: boolean;
};

export function SelectMenu({
  value,
  options,
  onChange,
  label,
  replayLabel = false,
  replayOptions = false,
  labelledBy,
  disabled = false,
  className = "",
  placement = "bottom",
  size = "default",
  triggerContent,
  triggerClassName,
  actionMenu = false,
  layout = "list",
  align,
  dismissOnScroll = false,
  showSelectedIcon = false,
  selectionIndicator = "check",
  closeOnSelect = true,
  menuHeader,
  menuSidebar,
  menuClassName = "",
  optionAction,
}: {
  menuHeader?: ReactNode;
  menuSidebar?: ReactNode;
  menuClassName?: string;
  optionAction?: (option: SelectMenuOption) => ReactNode;
  triggerContent?: ReactNode;
  triggerClassName?: string;
  actionMenu?: boolean;
  layout?: "list" | "horizontal";
  align?: "start" | "end";
  dismissOnScroll?: boolean;
  showSelectedIcon?: boolean;
  selectionIndicator?: "check" | "none";
  closeOnSelect?: boolean;
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  label: string;
  /** Only labels/options authored by the application may opt in. Values stay private. */
  replayLabel?: boolean;
  replayOptions?: boolean;
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
  const unavailable = disabled || (!menuHeader && !options.some((option) => !option.disabled));
  const visible = open && !unavailable;

  useLayoutEffect(() => {
    if (!visible || !menu.current || !trigger.current) return;
    const popup = menu.current;
    const anchor = trigger.current;
    popup.showPopover();
    function position(event?: Event) {
      if (event?.target instanceof Node && popup.contains(event.target)) return;
      if ((event?.type === "scroll" || event?.type === "wheel") && dismissOnScroll) {
        if (popup.contains(document.activeElement)) anchor.focus({ preventScroll: true });
        setOpen(false);
        return;
      }
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
      const alignRight = align ? align === "end" : placement === "top";
      popup.style.left = `${Math.max(margin, Math.min(alignRight ? bounds.right - size.width : bounds.left, window.innerWidth - size.width - margin))}px`;
      const top = useTop ? bounds.top - gap - size.height : bounds.bottom + gap;
      popup.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - size.height - margin))}px`;
    }
    position();
    const resize = new ResizeObserver(() => position());
    resize.observe(popup);
    const active =
      popup.querySelector<HTMLInputElement>("[data-select-search]") ??
      popup.querySelector<HTMLButtonElement>(
        '[role="menuitemradio"][aria-checked="true"]:not(:disabled)',
      ) ??
      popup.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)');
    active?.focus({ preventScroll: true });
    if (active)
      popup.scrollTop = Math.max(0, active.offsetTop + active.offsetHeight - popup.clientHeight);
    document.addEventListener("scroll", position, true);
    if (dismissOnScroll)
      document.addEventListener("wheel", position, { capture: true, passive: true });
    window.addEventListener("resize", position);
    return () => {
      resize.disconnect();
      document.removeEventListener("scroll", position, true);
      if (dismissOnScroll) document.removeEventListener("wheel", position, true);
      window.removeEventListener("resize", position);
      if (popup.matches(":popover-open")) popup.hidePopover();
    };
  }, [visible, placement, align, dismissOnScroll]);

  useEffect(() => {
    if (!visible) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    // Canvas controls stop bubbling pointer events; catch click-away before those handlers.
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [visible]);

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (menuHeader && event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      menu.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.click();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
      return;
    }
    if (
      menuHeader &&
      (event.key === "Tab" ||
        ((event.key === "Home" || event.key === "End") && event.target instanceof HTMLInputElement))
    )
      return;
    if (event.key === "Tab") {
      trigger.current?.focus({ preventScroll: true });
      setOpen(false);
      return;
    }
    const forward =
      event.key === "ArrowDown" || (layout === "horizontal" && event.key === "ArrowRight");
    const backward =
      event.key === "ArrowUp" || (layout === "horizontal" && event.key === "ArrowLeft");
    if (!forward && !backward && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role^="menuitem"]:not(:disabled)',
      ),
    ];
    const current = items.findIndex((item) => item === document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : forward
            ? (current + 1) % items.length
            : current < 0
              ? items.length - 1
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
        data-ph-control-label={replayLabel ? label : undefined}
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
          `flex w-full items-center justify-between gap-2 border border-control-border bg-surface text-left font-normal text-primary-black hover:border-primary-black focus-visible:outline-2 focus-visible:outline-primary-orange disabled:opacity-50 ${size === "sm" ? "h-8 rounded-md px-2 text-xs" : "min-h-10 rounded-lg px-3 text-sm"}`
        }
      >
        {triggerContent ?? (
          <>
            {showSelectedIcon && selected?.icon}
            <span data-ph-private id={valueId} className="truncate">
              {selected?.label ?? value}
            </span>
            <svg
              data-ph-public
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
          aria-orientation={layout === "horizontal" ? "horizontal" : undefined}
          popover="manual"
          data-ph-public-label={replayLabel || undefined}
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          onBlurCapture={(event) => {
            if (
              menuHeader &&
              event.relatedTarget instanceof Node &&
              !event.currentTarget.contains(event.relatedTarget) &&
              !trigger.current?.contains(event.relatedTarget)
            )
              setOpen(false);
          }}
          className={`fixed inset-auto z-50 m-0 max-h-64 w-max max-w-[min(28rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain rounded-xl border border-primary-grey bg-surface p-1 text-primary-black shadow-xl ${layout === "horizontal" ? "flex" : ""} ${menuClassName}`}
        >
          {menuHeader}
          <div className={menuSidebar ? "select-menu-columns" : "contents"}>
            {menuSidebar}
            <div className={optionAction ? "select-menu-options" : "contents"}>
              {options.length === 0 && menuHeader && (
                <p className="select-menu-empty">No matches</p>
              )}
              {options.map((option) => {
                const button = (
                  <button
                    type="button"
                    role={
                      option.checked !== undefined
                        ? "menuitemcheckbox"
                        : actionMenu
                          ? "menuitem"
                          : "menuitemradio"
                    }
                    aria-checked={
                      option.checked ?? (actionMenu ? undefined : value === option.value)
                    }
                    aria-label={option.ariaLabel}
                    disabled={option.disabled}
                    onClick={() => {
                      if (closeOnSelect) {
                        setOpen(false);
                        trigger.current?.focus({ preventScroll: true });
                      }
                      if (actionMenu || option.value !== value) onChange(option.value);
                    }}
                    className={`flex items-center rounded-lg font-normal enabled:hover:bg-primary-grey/20 focus-visible:bg-primary-grey/20 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-orange disabled:opacity-50 ${layout === "horizontal" ? "size-10 shrink-0 justify-center text-xl" : "min-h-9 w-full justify-between gap-2 px-2.5 text-left text-sm"} ${value === option.value ? "bg-primary-grey/20" : ""}`}
                  >
                    <span
                      data-slot="select-menu-content"
                      className="flex min-w-0 items-center gap-2"
                    >
                      {option.icon}
                      <span
                        data-slot="select-menu-text"
                        data-ph-public={replayOptions || undefined}
                        data-ph-private={!replayOptions || undefined}
                        className="min-w-0"
                      >
                        <span data-slot="select-menu-label" className="block truncate">
                          {option.label}
                        </span>
                        {option.description && (
                          <span
                            data-slot="select-menu-description"
                            className="mt-0.5 block whitespace-normal text-xs text-secondary-ink"
                          >
                            {option.description}
                          </span>
                        )}
                      </span>
                    </span>
                    {layout !== "horizontal" && selectionIndicator === "check" && (
                      <span aria-hidden="true" className="w-4 shrink-0 text-accent-ink">
                        {(option.checked ?? (!actionMenu && value === option.value)) && (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                            <path
                              d="M5 13L9 17L19 7"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </span>
                    )}
                  </button>
                );
                return optionAction ? (
                  <div key={option.value} className="select-menu-option-row">
                    {button}
                    {optionAction(option)}
                  </div>
                ) : (
                  <Fragment key={option.value}>{button}</Fragment>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
