"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { Icon } from "../components/ui/icon";

/** Stay beside the selected row without changing the sidebar's layout or scroll position. */
export function TokenEditorPopover({
  anchor,
  name,
  title,
  readOnly,
  onRemove,
  onClose,
  children,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  name: string;
  title: string;
  readOnly: boolean;
  onRemove: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const latest = useRef(onClose);
  useLayoutEffect(() => {
    latest.current = onClose;
  });
  useLayoutEffect(() => {
    const popup = panel.current;
    if (!popup) return;
    popup.showPopover();
    popup.focus({ preventScroll: true });
    return () => {
      if (popup.matches(":popover-open")) popup.hidePopover();
    };
  }, []);
  useLayoutEffect(() => {
    const popup = panel.current;
    if (!popup) return;
    function position() {
      const row = anchor.current;
      if (!row || !popup) return;
      const bounds = row.getBoundingClientRect();
      const margin = 12,
        gap = 12;
      const width = popup.offsetWidth,
        height = popup.offsetHeight;
      const right = bounds.right + gap;
      const left = right + width <= window.innerWidth - margin ? right : bounds.left - gap - width;
      popup.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - width - margin))}px`;
      popup.style.top = `${Math.max(margin, Math.min(bounds.top - 12, window.innerHeight - height - margin))}px`;
    }
    position();
    const resize = new ResizeObserver(position);
    resize.observe(popup);
    if (anchor.current) resize.observe(anchor.current);
    document.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      resize.disconnect();
      document.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [anchor, name]);
  useEffect(() => {
    function dismiss(event: PointerEvent) {
      const popup = panel.current;
      if (!(event.target instanceof Element) || !popup || popup.contains(event.target)) return;
      // Row clicks switch the editor directly, without a close/reopen race.
      if (
        event.target.closest("[data-token-name]")?.closest('[role="tabpanel"]') ===
        anchor.current?.closest('[role="tabpanel"]')
      )
        return;
      const focused = document.activeElement;
      // Commit the focused field before dismissing on a canvas pointer-down.
      if (focused instanceof HTMLElement && popup.contains(focused)) focused.blur();
      latest.current();
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || panel.current?.querySelector(":popover-open")) return;
      event.preventDefault();
      event.stopPropagation();
      anchor.current?.focus({ preventScroll: true });
      latest.current();
    }
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape);
    };
  }, [anchor]);
  const action =
    "flex h-7 w-7 items-center justify-center rounded-md text-secondary-ink hover:bg-hover-surface hover:text-primary-black focus-visible:outline-2 focus-visible:outline-primary-orange";
  return (
    <div
      ref={panel}
      popover="manual"
      role="dialog"
      aria-label={`${title} token`}
      tabIndex={-1}
      className="token-editor fixed m-0 w-[360px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-primary-grey/70 bg-surface text-primary-black outline-none"
    >
      <header className="flex h-12 items-center gap-1 border-b border-primary-grey/50 px-4">
        <span className="flex-1 text-xs font-medium">{title}</span>
        {!readOnly && (
          <button
            type="button"
            aria-label={`Remove token ${name}`}
            title="Delete token"
            onClick={onRemove}
            className={action}
          >
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5" />
            </svg>
          </button>
        )}
        <button
          type="button"
          aria-label="Close token editor"
          title="Close"
          onClick={() => {
            anchor.current?.focus({ preventScroll: true });
            onClose();
          }}
          className={action}
        >
          <Icon name="xmark" size={16} />
        </button>
      </header>
      <fieldset
        disabled={readOnly}
        className="max-h-[calc(100dvh-80px)] min-w-0 space-y-3 overflow-y-auto overscroll-contain p-4"
      >
        {children}
      </fieldset>
    </div>
  );
}
