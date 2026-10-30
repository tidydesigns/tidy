import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type MouseEvent,
} from "react";

type Drag = {
  id: string;
  pointerId: number;
  clientY: number;
  grabOffset: number;
  row: HTMLElement;
  initialOrder: string[];
} & ({ kind: "pending"; startY: number } | { kind: "dragging"; lastSwapY: number });

export function useThreadDrag({ ids, setOrder }: { ids: string[]; setOrder(ids: string[]): void }) {
  const list = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const currentIds = useRef(ids);
  const previousTops = useRef(new Map<string, number>());
  const suppressClick = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const finishRef = useRef<((cancel: boolean) => void) | null>(null);

  useLayoutEffect(() => {
    currentIds.current = ids;
    const active = drag.current;
    if (active && (!ids.includes(active.id) || !active.row.isConnected)) {
      finishRef.current?.(false);
      return;
    }
    if (active?.kind !== "dragging") {
      previousTops.current.clear();
      return;
    }
    const rows = list.current?.querySelectorAll<HTMLElement>("[data-thread-id]");
    if (!rows) return;
    const nextTops = new Map<string, number>();
    for (const row of rows) {
      const id = row.dataset.threadId;
      if (!id) continue;
      const top = row.offsetTop;
      nextTops.set(id, top);
      const previous = previousTops.current.get(id);
      if (active.id !== id && previous !== undefined && previous !== top) {
        row.getAnimations().forEach((animation) => animation.cancel());
        if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
          row.animate(
            [{ transform: `translateY(${previous - top}px)` }, { transform: "translateY(0)" }],
            {
              duration: 160,
              easing: "cubic-bezier(.2,.8,.2,1)",
            },
          );
        }
      }
    }
    previousTops.current = nextTops;
    position(active);
  });

  function position(active: Drag) {
    const container = list.current;
    if (!container) return active.clientY - active.grabOffset;
    const bounds = container.getBoundingClientRect();
    const viewport = container.parentElement?.getBoundingClientRect() ?? bounds;
    const minimum = Math.max(bounds.top, viewport.top);
    const maximum = Math.max(
      minimum,
      Math.min(bounds.bottom, viewport.bottom) - active.row.offsetHeight,
    );
    const top = Math.min(maximum, Math.max(minimum, active.clientY - active.grabOffset));
    active.row.style.transform = `translateY(${top - bounds.top - active.row.offsetTop}px)`;
    return top;
  }

  useLayoutEffect(() => {
    let frame = 0;
    let previousTime = 0;
    function tick(time: number) {
      const active = drag.current;
      const container = list.current;
      if (active?.kind !== "dragging" || !container) return;
      const scroll = container.parentElement;
      if (scroll) {
        const bounds = scroll.getBoundingClientRect();
        const edge = 40;
        const speed =
          active.clientY < bounds.top + edge
            ? -Math.min(1, (bounds.top + edge - active.clientY) / edge)
            : active.clientY > bounds.bottom - edge
              ? Math.min(1, (active.clientY - bounds.bottom + edge) / edge)
              : 0;
        scroll.scrollTop += speed * Math.min(time - (previousTime || time), 32) * 0.6;
      }
      previousTime = time;
      const top = position(active);
      const contentY = top + active.grabOffset + (scroll?.scrollTop ?? 0);
      const travel = contentY - active.lastSwapY;
      const bottom = top + active.row.offsetHeight;
      const listTop = container.getBoundingClientRect().top;
      const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-thread-id]"));
      const ranks = new Map(currentIds.current.map((id, index) => [id, index]));
      const index = ranks.get(active.id) ?? -1;
      let destination = index;
      for (const row of rows) {
        const id = row.dataset.threadId;
        if (!id || id === active.id) continue;
        const rowIndex = ranks.get(id);
        if (rowIndex === undefined) continue;
        const rowTop = listTop + row.offsetTop;
        const overlap = Math.min(20, row.offsetHeight / 4, active.row.offsetHeight / 4);
        if (travel >= 6 && rowIndex > index && bottom > rowTop + overlap)
          destination = Math.max(destination, rowIndex);
        if (travel <= -6 && rowIndex < index && top < rowTop + row.offsetHeight - overlap)
          destination = Math.min(destination, rowIndex);
      }
      if (destination !== index && index >= 0) {
        const next = currentIds.current.filter((id) => id !== active.id);
        next.splice(destination, 0, active.id);
        currentIds.current = next;
        active.lastSwapY = contentY;
        setOrder(next);
      }
      frame = requestAnimationFrame(tick);
    }
    function finish(cancel: boolean) {
      const active = drag.current;
      if (!active) return;
      drag.current = null;
      cancelAnimationFrame(frame);
      previousTime = 0;
      active.row.style.transform = "";
      active.row.classList.remove("thread-dragging");
      if (list.current?.hasPointerCapture(active.pointerId))
        list.current.releasePointerCapture(active.pointerId);
      if (active.kind === "dragging" && cancel) setOrder(active.initialOrder);
      setDraggingId(null);
    }
    finishRef.current = finish;
    const container = list.current;
    if (!container) return;
    function move(event: globalThis.PointerEvent) {
      let active = drag.current;
      const container = list.current;
      if (!active || !container || event.pointerId !== active.pointerId) return;
      active.clientY = event.clientY;
      if (active.kind === "pending" && Math.abs(event.clientY - active.startY) >= 5) {
        container.setPointerCapture(active.pointerId);
        const { startY, ...session } = active;
        active = {
          ...session,
          kind: "dragging",
          lastSwapY:
            position({ ...active, clientY: startY }) +
            active.grabOffset +
            (container.parentElement?.scrollTop ?? 0),
        };
        drag.current = active;
        suppressClick.current = true;
        active.row.classList.add("thread-dragging");
        setDraggingId(active.id);
        frame = requestAnimationFrame(tick);
      }
      if (active.kind === "dragging") event.preventDefault();
    }
    function up(event: globalThis.PointerEvent) {
      if (event.pointerId !== drag.current?.pointerId) return;
      if (drag.current.kind === "dragging") {
        cancelAnimationFrame(frame);
        tick(performance.now());
      }
      finish(false);
    }
    function cancel(event: Event) {
      if (event instanceof globalThis.PointerEvent && event.pointerId !== drag.current?.pointerId)
        return;
      finish(true);
    }
    function key(event: KeyboardEvent) {
      if (event.key === "Escape" && drag.current) {
        event.preventDefault();
        finish(true);
      }
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    container.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key);
    return () => {
      finish(true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      container.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key);
    };
  }, [setOrder]);

  return {
    list,
    draggingId,
    onPointerDown: useCallback(
      ({ event, id }: { event: PointerEvent<HTMLElement>; id: string }) => {
        if (event.button !== 0 || !event.isPrimary || drag.current) return;
        if (!(event.target instanceof Element) || !event.target.closest(".thread-select")) return;
        const row = event.currentTarget.closest<HTMLElement>("[data-thread-id]");
        if (!row || !list.current) return;
        suppressClick.current = false;
        drag.current = {
          id,
          pointerId: event.pointerId,
          startY: event.clientY,
          clientY: event.clientY,
          grabOffset: event.clientY - row.getBoundingClientRect().top,
          row,
          initialOrder: [...currentIds.current],
          kind: "pending",
        };
      },
      [],
    ),
    move: useCallback(
      ({ id, to, after }: { id: string; to: string; after: boolean }) => {
        if (id === to) return;
        const next = currentIds.current.filter((item) => item !== id);
        const index = next.indexOf(to);
        if (index < 0) return;
        next.splice(index + (after ? 1 : 0), 0, id);
        currentIds.current = next;
        setOrder(next);
      },
      [setOrder],
    ),
    onClickCapture(event: MouseEvent<HTMLElement>) {
      if (suppressClick.current && event.detail !== 0) {
        event.preventDefault();
        event.stopPropagation();
        suppressClick.current = false;
      }
    },
  };
}
