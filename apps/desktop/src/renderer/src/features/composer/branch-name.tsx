import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

export function BranchName({
  name,
  revealOnFocus = true,
}: {
  name: string;
  revealOnFocus?: boolean;
}) {
  const text = useRef<HTMLSpanElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const id = useId();
  const dismissTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const label = text.current;
    const button = label?.closest("button");
    if (!label || !button) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function show() {
      if (!label || button?.getAttribute("aria-expanded") === "true") return;
      const clipped = label.scrollWidth > label.clientWidth;
      setVisible(clipped);
    }
    function hide() {
      clearTimeout(timer);
      clearTimeout(dismissTimer.current);
      setVisible(false);
    }
    function leave() {
      clearTimeout(timer);
      dismissTimer.current = setTimeout(() => setVisible(false), 100);
    }
    function hover() {
      clearTimeout(dismissTimer.current);
      timer = setTimeout(show, 350);
    }
    if (revealOnFocus) button.addEventListener("focus", show);
    button.addEventListener("blur", hide);
    button.addEventListener("pointerenter", hover);
    button.addEventListener("pointerleave", leave);
    return () => {
      clearTimeout(timer);
      clearTimeout(dismissTimer.current);
      button.removeEventListener("focus", show);
      button.removeEventListener("blur", hide);
      button.removeEventListener("pointerenter", hover);
      button.removeEventListener("pointerleave", leave);
    };
  }, [name, revealOnFocus]);

  useLayoutEffect(() => {
    const popup = tooltip.current;
    const button = text.current?.closest("button");
    if (!visible || !popup || !button) return;
    popup.showPopover();
    function position() {
      if (!popup || !button) return;
      const bounds = button.getBoundingClientRect();
      const size = popup.getBoundingClientRect();
      popup.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - size.width - 8))}px`;
      popup.style.top = `${Math.max(8, Math.min(bounds.top - size.height - 4, innerHeight - size.height - 8))}px`;
    }
    position();
    button.setAttribute("aria-describedby", id);
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && popup.contains(event.target)) return;
      if (event.type === "scroll" && document.activeElement === button) {
        position();
        return;
      }
      setVisible(false);
    };
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      button.removeAttribute("aria-describedby");
      if (popup.matches(":popover-open")) popup.hidePopover();
    };
  }, [visible, id]);

  return (
    <>
      <span ref={text} className="branch-name" data-ph-private>
        {name}
      </span>
      {visible && (
        <div
          ref={tooltip}
          id={id}
          className="branch-name-tooltip"
          role="tooltip"
          onPointerEnter={() => clearTimeout(dismissTimer.current)}
          onPointerLeave={() => setVisible(false)}
          popover="manual"
          data-ph-private
        >
          {name}
        </div>
      )}
    </>
  );
}
