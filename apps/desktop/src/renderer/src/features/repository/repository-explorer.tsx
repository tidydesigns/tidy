import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { useSessionState } from "../../app/session-state";

export function RepositoryExplorer({
  projectId,
  view,
  resizable,
  children,
}: {
  projectId: string;
  view: string;
  resizable: boolean;
  children: ReactNode;
}) {
  const [savedWidth, setWidth] = useSessionState(
    `repository-explorer-width:${projectId}:${view}`,
    z.number().min(128).max(560).nullable(),
    null,
  );
  const [available, setAvailable] = useState(640);
  const element = useRef<HTMLElement>(null);
  const drag = useRef<{ id: number; x: number; width: number; current: number } | null>(null);
  const maximum = Math.max(128, Math.min(560, available - 256));
  const width = Math.max(128, Math.min(savedWidth ?? Math.min(256, available * 0.4), maximum));
  const clamp = (value: number) => Math.round(Math.max(128, Math.min(maximum, value)));
  useLayoutEffect(() => {
    const row = element.current?.parentElement;
    if (!row) return;
    const measure = () => setAvailable(row.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    measure();
    return () => observer.disconnect();
  }, []);
  return (
    <aside
      ref={element}
      className={`repository-explorer relative flex min-h-0 min-w-0 ${resizable ? "flex-[0_0_auto] border-l border-(--repository-hairline)" : "flex-1"}`}
      data-resizable={resizable || undefined}
      style={resizable ? { width, flexBasis: width } : undefined}
      aria-label="File explorer"
    >
      {resizable && (
        <div
          className="repository-explorer-resize absolute inset-y-0 -left-[3px] z-5 w-[6px] cursor-col-resize touch-none hover:bg-border focus-visible:bg-border focus-visible:outline-none"
          role="separator"
          aria-label="Resize file explorer"
          aria-orientation="vertical"
          aria-valuemin={128}
          aria-valuemax={maximum}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowLeft"
                ? width + 16
                : event.key === "ArrowRight"
                  ? width - 16
                  : event.key === "Home"
                    ? 128
                    : event.key === "End"
                      ? maximum
                      : null;
            if (next !== null) {
              event.preventDefault();
              event.stopPropagation();
              setWidth(clamp(next));
            }
          }}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0 || drag.current) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { id: event.pointerId, x: event.clientX, width, current: width };
          }}
          onPointerMove={(event) => {
            if (drag.current?.id !== event.pointerId || !element.current) return;
            const next = clamp(drag.current.width + drag.current.x - event.clientX);
            drag.current.current = next;
            element.current.style.width = `${next}px`;
            element.current.style.flexBasis = `${next}px`;
            event.currentTarget.setAttribute("aria-valuenow", String(next));
          }}
          onPointerUp={(event) => {
            if (drag.current?.id !== event.pointerId) return;
            setWidth(drag.current.current);
            drag.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            if (drag.current) setWidth(drag.current.current);
            drag.current = null;
          }}
        />
      )}
      {children}
    </aside>
  );
}
