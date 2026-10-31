import { useLayoutEffect, useRef, type ReactNode } from "react";

export function AnimatedHeight({ open, children }: { open: boolean; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = frame.current;
    const inner = content.current;
    if (!element || !inner) return;
    if (!open) {
      element.style.height = "0px";
      return;
    }
    const measure = () => {
      element.style.height = `${inner.offsetHeight}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [open]);
  return (
    <div
      ref={frame}
      className="thread-animated-height"
      data-open={open || undefined}
      aria-hidden={!open || undefined}
      inert={!open}
    >
      <div ref={content} className="thread-animated-content">
        {children}
      </div>
    </div>
  );
}
