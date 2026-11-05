import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Message, Thread } from "../../../../shared/contracts/desktop";
import { TurnStatus } from "./turn-status";

type Row = {
  element: HTMLDivElement;
  content: HTMLDivElement;
  open: boolean;
  motion: Animation | null;
};

const WorkRow = memo(function WorkRow({
  id,
  open,
  bounded,
  rows,
  children,
}: {
  id: string;
  open: boolean;
  bounded: boolean;
  rows: Map<string, Row>;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const currentOpen = useRef(open);
  currentOpen.current = open;
  const region = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = region.current;
    const body = content.current;
    if (!element || !body) return;
    const row: Row = { element, content: body, open: currentOpen.current, motion: null };
    element.style.height = row.open ? "auto" : "0px";
    element.style.opacity = row.open ? "1" : "0";
    rows.set(id, row);
    return () => {
      row.motion?.cancel();
      rows.delete(id);
    };
  }, [id, rows]);
  return (
    <div className="turn-work-region" ref={region} inert={!open} aria-hidden={!open}>
      <div className="turn-work-content" ref={content} data-bounded={bounded ? "" : undefined}>
        {mounted ? children : null}
      </div>
    </div>
  );
});

export function TurnWork({
  message,
  thread,
  visible,
  completed,
  items,
}: {
  message?: Message;
  thread?: Thread;
  visible: boolean;
  completed: boolean;
  items: { id: string; collapsible: boolean; content: (visible: boolean) => ReactNode }[];
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [bounded, setBounded] = useState(completed);
  const [instant, setInstant] = useState(false);
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const surface = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, Row>());
  const open = !completed || expanded;
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(preference.matches);
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    if (!completed) {
      setExpanded(false);
      setBounded(false);
      setInstant(false);
    }
  }, [completed]);
  useLayoutEffect(() => {
    const immediate = instant || reduced || !visible;
    const pending = items.flatMap((item) => {
      const row = rows.current.get(item.id);
      const nextOpen = !item.collapsible || open;
      return row && (row.open !== nextOpen || (immediate && row.motion)) ? [{ row, nextOpen }] : [];
    });
    if (!pending.length) return;
    const viewport = surface.current?.closest(".transcript")?.getBoundingClientRect();
    let offset = 0;
    const changes = pending.map(({ row, nextOpen }) => {
      const bounds = immediate ? undefined : row.element.getBoundingClientRect();
      const target = !immediate && nextOpen ? row.content.getBoundingClientRect().height : 0;
      const top = (bounds?.top ?? 0) + (nextOpen ? offset : 0);
      const height = bounds?.height ?? 0;
      offset += target - height;
      const animate =
        !immediate &&
        (!viewport || (top < viewport.bottom && top + (nextOpen ? target : height) > viewport.top));
      return {
        row,
        nextOpen,
        height,
        target,
        animate,
        opacity: animate ? getComputedStyle(row.element).opacity : "1",
      };
    });
    if (
      changes.some(({ row, nextOpen }) => !nextOpen && row.element.contains(document.activeElement))
    )
      surface.current
        ?.querySelector<HTMLButtonElement>(".turn-work-summary")
        ?.focus({ preventScroll: true });
    for (const { row, nextOpen, height, opacity, target, animate } of changes) {
      row.motion?.cancel();
      row.motion = null;
      row.open = nextOpen;
      const finish = () => {
        row.element.style.height = nextOpen ? "auto" : "0px";
        row.element.style.opacity = nextOpen ? "1" : "0";
      };
      if (!animate) {
        finish();
        continue;
      }
      row.element.style.height = `${height}px`;
      const animation = row.element.animate(
        [
          { height: `${height}px`, opacity },
          { height: `${target}px`, opacity: nextOpen ? 1 : 0 },
        ],
        { duration: 240, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "forwards" },
      );
      row.motion = animation;
      animation.onfinish = () => {
        if (row.motion !== animation) return;
        finish();
        animation.cancel();
        row.motion = null;
      };
    }
  }, [items, open, instant, reduced, visible]);
  return (
    <div
      className="turn-work"
      ref={surface}
      data-completed={completed ? "" : undefined}
      data-expanded={open ? "" : undefined}
      data-instant={instant ? "" : undefined}
    >
      {message && (
        <TurnStatus
          message={message}
          thread={thread}
          visible={visible}
          disclosure={
            completed
              ? {
                  expanded,
                  controls: id,
                  toggle: (immediate) => {
                    setInstant(immediate);
                    setBounded(true);
                    setExpanded((value) => !value);
                  },
                }
              : undefined
          }
        />
      )}
      <div id={id}>
        {items.map((item) => (
          <WorkRow
            key={item.id}
            id={item.id}
            rows={rows.current}
            open={!item.collapsible || open}
            bounded={completed && bounded && item.collapsible}
          >
            {item.content(visible && (!item.collapsible || open))}
          </WorkRow>
        ))}
      </div>
    </div>
  );
}
