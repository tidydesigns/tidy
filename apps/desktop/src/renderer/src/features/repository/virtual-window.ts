import { useCallback, useLayoutEffect, useRef, useState } from "react";

export function useVirtualWindow(count: number, rowHeight: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const attach = useCallback((node: HTMLDivElement | null) => {
    ref.current = node;
    setElement(node);
  }, []);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  useLayoutEffect(() => {
    const node = element;
    if (!node) return;
    let frame: number | undefined;
    let measured: { top: number; height: number } | undefined;
    const measure = () => {
      const top = Math.floor(node.scrollTop / rowHeight) * rowHeight;
      const height = node.clientHeight;
      if (measured?.top === top && measured.height === height) return;
      measured = { top, height };
      setViewport(measured);
    };
    const update = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        measure();
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    node.addEventListener("scroll", update, { passive: true });
    measure();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      node.removeEventListener("scroll", update);
    };
  }, [element, rowHeight]);
  const start = Math.max(0, Math.min(count - 1, Math.floor(viewport.top / rowHeight)) - 8);
  const end = Math.min(count, start + Math.ceil(viewport.height / rowHeight) + 16);
  function reveal(index: number) {
    const node = ref.current;
    if (!node) return;
    const top = index * rowHeight;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (top + rowHeight > node.scrollTop + node.clientHeight)
      node.scrollTop = top + rowHeight - node.clientHeight;
    else return;
    setViewport({ top: node.scrollTop, height: node.clientHeight });
  }
  return { ref, attach, start, end, reveal };
}
