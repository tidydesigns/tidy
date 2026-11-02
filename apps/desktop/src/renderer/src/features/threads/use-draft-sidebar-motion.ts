import { useLayoutEffect, useRef, type RefObject } from "react";

const timing = { duration: 150, easing: "ease-out" };
type Row = { top: number; left: number; width: number; height: number };
type MovingRow = { animation: Animation; offset: number; entering: boolean };

export function useDraftSidebarMotion({
  list,
  visible,
  scope,
  order,
  dragging,
}: {
  list: RefObject<HTMLDivElement | null>;
  visible: boolean;
  scope: string;
  order: string;
  dragging: boolean;
}) {
  const previous = useRef<{
    scope: string;
    visible: boolean;
    scrollTop: number;
    rows: Map<HTMLElement, Row>;
  } | null>(null);
  const moving = useRef(new Map<HTMLElement, MovingRow>());
  const ghosts = useRef(new Map<HTMLElement, Animation>());
  const pointer = useRef(true);

  useLayoutEffect(() => {
    const document = list.current?.ownerDocument;
    if (!document) return;
    const reduce = document.defaultView?.matchMedia("(prefers-reduced-motion: reduce)");
    const cancel = () => {
      for (const { animation } of moving.current.values()) animation.cancel();
      moving.current.clear();
      for (const [ghost, animation] of ghosts.current) {
        animation.cancel();
        ghost.remove();
      }
      ghosts.current.clear();
    };
    const scroll = list.current?.parentElement;
    const scrolled = () => {
      if (previous.current) previous.current.scrollTop = scroll?.scrollTop ?? 0;
    };
    const keyboard = () => {
      pointer.current = false;
      cancel();
    };
    const press = () => {
      pointer.current = true;
    };
    scroll?.addEventListener("scroll", scrolled, { passive: true });
    document.addEventListener("keydown", keyboard, true);
    document.addEventListener("pointerdown", press, true);
    reduce?.addEventListener("change", cancel);
    return () => {
      scroll?.removeEventListener("scroll", scrolled);
      document.removeEventListener("keydown", keyboard, true);
      document.removeEventListener("pointerdown", press, true);
      reduce?.removeEventListener("change", cancel);
      cancel();
      previous.current = null;
    };
  }, [list]);

  useLayoutEffect(() => {
    const parent = list.current;
    if (!parent) return;
    const rows = new Map<HTMLElement, Row>();
    for (const node of parent.children) {
      if (node instanceof HTMLElement && !ghosts.current.has(node))
        rows.set(node, {
          top: node.offsetTop,
          left: node.matches(".thread-select") ? node.offsetLeft : 0,
          width: node.matches(".thread-select") ? node.offsetWidth : 0,
          height: node.offsetHeight,
        });
    }
    const before = previous.current;
    const scrollTop = parent.parentElement?.scrollTop ?? 0;
    previous.current = { scope, visible, scrollTop, rows };
    const reduce = parent.ownerDocument.defaultView?.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (!before || before.scope !== scope || dragging || reduce || !pointer.current) {
      for (const { animation } of moving.current.values()) animation.cancel();
      moving.current.clear();
      for (const [ghost, animation] of ghosts.current) {
        animation.cancel();
        ghost.remove();
      }
      ghosts.current.clear();
      return;
    }
    if (before.visible === visible) return;
    const bounds = parent.getBoundingClientRect();
    const viewport = parent.parentElement?.getBoundingClientRect() ?? bounds;
    const viewportTop = viewport.top - bounds.top;
    const viewportBottom = viewport.bottom - bounds.top;
    const inViewport = (top: number, height: number) =>
      top < viewportBottom && top + height > viewportTop;
    const offsets = new Map<HTMLElement, number>();
    for (const [node, row] of before.rows) {
      const current = moving.current.get(node);
      const progress = current?.animation.effect?.getComputedTiming().progress ?? 1;
      offsets.set(
        node,
        row.top + (current?.offset ?? 0) * (1 - progress) + scrollTop - before.scrollTop,
      );
    }
    for (const [ghost, animation] of ghosts.current) {
      animation.cancel();
      ghost.remove();
    }
    ghosts.current.clear();
    for (const [node, row] of before.rows) {
      if (
        rows.has(node) ||
        row.height === 0 ||
        !node.matches(".thread-select") ||
        !inViewport(offsets.get(node) ?? row.top, row.height)
      )
        continue;
      const ghost = node.cloneNode(true);
      if (!(ghost instanceof HTMLElement)) continue;
      ghost.classList.remove("thread-select");
      ghost.removeAttribute("aria-current");
      ghost.setAttribute("aria-hidden", "true");
      ghost.inert = true;
      Object.assign(ghost.style, {
        position: "absolute",
        top: `${offsets.get(node) ?? row.top}px`,
        left: `${row.left}px`,
        width: `${row.width}px`,
        height: `${row.height}px`,
        margin: "0",
        pointerEvents: "none",
      });
      parent.append(ghost);
      const current = moving.current.get(node);
      const opacity = current?.entering
        ? (current.animation.effect?.getComputedTiming().progress ?? 1)
        : 1;
      const animation = ghost.animate(
        [
          { opacity, transform: "translateY(0px)" },
          { opacity: 0, transform: `translateY(${Math.min(row.height, 40)}px)` },
        ],
        timing,
      );
      ghosts.current.set(ghost, animation);
      animation.addEventListener(
        "finish",
        () => {
          ghost.remove();
          ghosts.current.delete(ghost);
        },
        { once: true },
      );
    }
    for (const { animation } of moving.current.values()) animation.cancel();
    moving.current.clear();
    for (const [node, row] of rows) {
      if (row.height === 0) continue;
      const oldTop = offsets.get(node);
      const entering = oldTop === undefined;
      const offset = entering ? -Math.min(row.height, 40) : oldTop - row.top;
      if (!offset && !entering) continue;
      if (!inViewport(row.top, row.height) && !inViewport(row.top + offset, row.height)) continue;
      const animation = node.animate(
        [
          { transform: `translateY(${offset}px)`, ...(entering ? { opacity: 0 } : {}) },
          { transform: "translateY(0px)", ...(entering ? { opacity: 1 } : {}) },
        ],
        timing,
      );
      moving.current.set(node, { animation, offset, entering });
      animation.addEventListener(
        "finish",
        () => {
          if (moving.current.get(node)?.animation === animation) moving.current.delete(node);
        },
        { once: true },
      );
    }
  }, [list, visible, scope, order, dragging]);
}
