import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentPropsWithRef,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@tidy/ui/button";

let lastDismissed = 0;

export function TerminalButton({
  tooltip,
  shortcut,
  ref,
  ...props
}: ComponentPropsWithRef<typeof Button> & { tooltip: string; shortcut?: string }) {
  const button = useRef<HTMLButtonElement>(null);
  useImperativeHandle(ref, () => button.current!);
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState<{ left: number; top: number; below: boolean }>();
  const hide = () => {
    clearTimeout(timer.current);
    if (position) lastDismissed = Date.now();
    setPosition(undefined);
  };
  const show = (delay: number) => {
    clearTimeout(timer.current);
    const reveal = () => {
      const bounds = button.current?.getBoundingClientRect();
      if (!bounds) return;
      const below = bounds.top < 56;
      setPosition({
        left: Math.max(140, Math.min(window.innerWidth - 140, bounds.left + bounds.width / 2)),
        top: below ? bounds.bottom + 8 : bounds.top - 8,
        below,
      });
    };
    if (delay) timer.current = setTimeout(reveal, delay);
    else reveal();
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!position) return;
    const close = () => hide();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [position]);
  return (
    <>
      <Button
        {...props}
        ref={button}
        aria-describedby={position ? id : undefined}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") show(Date.now() - lastDismissed < 350 ? 0 : 400);
        }}
        onPointerLeave={hide}
        onFocus={() => {
          if (button.current?.matches(":focus-visible")) show(0);
        }}
        onBlur={hide}
        onClick={(event) => {
          hide();
          props.onClick?.(event);
        }}
      />
      {position &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            className="terminal-tooltip"
            data-below={position.below}
            style={{ left: position.left, top: position.top }}
          >
            <span>{tooltip}</span>
            {shortcut && <kbd>{shortcut}</kbd>}
          </span>,
          document.body,
        )}
    </>
  );
}
