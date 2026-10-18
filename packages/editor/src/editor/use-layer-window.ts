"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { useEditorEvent } from "./use-editor-event";
const ROW_HEIGHT = 32;
export function useLayerWindow(count: number, selectedIndex: number) {
  const tree = useRef<HTMLDivElement>(null);
  const [window, setWindow] = useState({ start: 0, end: 40 });
  const virtual = count > 200;
  const measure = useEditorEvent(() => {
    const element = tree.current,
      scroller = element?.closest<HTMLElement>('[role="tabpanel"]');
    if (!element || !scroller) return;
    const top =
      element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    const start = Math.min(
      count - 1,
      Math.max(0, Math.floor((scroller.scrollTop - top) / ROW_HEIGHT) - 12),
    );
    const end = Math.min(
      count,
      Math.max(
        start + 1,
        Math.ceil((scroller.scrollTop + scroller.clientHeight - top) / ROW_HEIGHT) + 12,
      ),
    );
    setWindow((old) => (old.start === start && old.end === end ? old : { start, end }));
  });
  useLayoutEffect(() => {
    if (!virtual) return;
    const element = tree.current,
      scroller = element?.closest<HTMLElement>('[role="tabpanel"]');
    if (!element || !scroller) return;
    let frame: number | undefined;
    const schedule = () => {
      if (frame === undefined)
        frame = requestAnimationFrame(() => {
          frame = undefined;
          measure();
        });
    };
    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    observer.observe(element);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [virtual, count, measure]);
  useLayoutEffect(() => {
    if (!virtual || selectedIndex < 0) return;
    const element = tree.current,
      scroller = element?.closest<HTMLElement>('[role="tabpanel"]');
    if (!element || !scroller) return;
    const top =
      element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop +
      selectedIndex * ROW_HEIGHT;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight)
      scroller.scrollTop = top + ROW_HEIGHT - scroller.clientHeight;
    measure();
  }, [virtual, selectedIndex, measure]);
  return {
    tree,
    start: virtual ? window.start : 0,
    end: virtual ? window.end : count,
    virtual,
    rowHeight: ROW_HEIGHT,
  };
}
