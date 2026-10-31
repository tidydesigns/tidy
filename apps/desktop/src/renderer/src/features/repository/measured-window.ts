import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { CodeRow } from "./file-rows";

const emptyHeights = new Map<number, number>();
export function rowAtOffset(offsets: Float64Array, top: number) {
  let low = 0,
    high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= top) low = middle;
    else high = middle - 1;
  }
  return low;
}
export function useMeasuredWindow(rows: readonly CodeRow[], split = false) {
  const ref = useRef<HTMLDivElement>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const attach = useCallback((node: HTMLDivElement | null) => {
    ref.current = node;
    setElement(node);
  }, []);
  const [viewport, setViewport] = useState({ first: 0, width: 0, height: 600 });
  const [measured, setMeasured] = useState({ rows, width: 0, split, heights: emptyHeights });
  const heights =
    measured.rows === rows && measured.width === viewport.width && measured.split === split
      ? measured.heights
      : emptyHeights;
  const estimates = useMemo(() => {
    const charactersPerLine = Math.max(1, Math.floor((viewport.width / (split ? 2 : 1) - 84) / 8));
    return rows.map((row) =>
      viewport.width > 0 && row.kind === "lines"
        ? 24 *
          Math.max(
            1,
            Math.ceil(
              Math.max(row.before?.text.length ?? 0, row.after?.text.length ?? 0) /
                charactersPerLine,
            ),
          )
        : 24,
    );
  }, [rows, viewport.width, split]);
  const offsets = useMemo(() => {
    const value = new Float64Array(rows.length + 1);
    for (let index = 0; index < rows.length; index++)
      value[index + 1] = value[index] + (heights.get(index) ?? estimates[index]);
    return value;
  }, [rows.length, heights, estimates]);
  const latestOffsets = useRef(offsets);
  const anchor = useRef<{
    index: number;
    within: number;
    top: number;
    rows: readonly CodeRow[];
  } | null>(null);
  useLayoutEffect(() => {
    latestOffsets.current = offsets;
    const saved = anchor.current;
    anchor.current = null;
    if (element && saved && saved.rows === rows && Math.abs(element.scrollTop - saved.top) < 1)
      element.scrollTop = offsets[saved.index] + saved.within;
    if (element) {
      const first = rowAtOffset(offsets, element.scrollTop);
      setViewport((previous) => (previous.first === first ? previous : { ...previous, first }));
    }
  }, [element, offsets, rows]);
  useLayoutEffect(() => {
    if (!element) return;
    let frame: number | undefined;
    const update = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const first = rowAtOffset(latestOffsets.current, element.scrollTop);
        const width = element.clientWidth,
          height = element.clientHeight;
        setViewport((previous) =>
          previous.first === first && previous.width === width && previous.height === height
            ? previous
            : { first, width, height },
        );
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [element]);
  const first = Math.min(viewport.first, Math.max(0, rows.length - 1));
  const start = rowAtOffset(offsets, Math.max(0, offsets[first] - 144));
  const end = Math.min(
    rows.length,
    rowAtOffset(offsets, offsets[first] + viewport.height + 192) + 1,
  );
  useLayoutEffect(() => {
    if (!element) return;
    let frame: number | undefined;
    const pending = new Map<number, number>();
    const applyMeasurements = () => {
      if (!pending.size) return;
      const index = rowAtOffset(latestOffsets.current, element.scrollTop);
      anchor.current = {
        rows,
        index,
        within: element.scrollTop - latestOffsets.current[index],
        top: element.scrollTop,
      };
      const next = new Map(heights);
      for (const [index, size] of pending) next.set(index, size);
      pending.clear();
      setMeasured({ rows, width: viewport.width, split, heights: next });
    };
    const measure = (target: Element, height: number) => {
      const index = Number(target.getAttribute("data-row"));
      const size = Math.max(24, Math.ceil(height));
      if (Math.abs((heights.get(index) ?? estimates[index]) - size) >= 1) pending.set(index, size);
    };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries)
        measure(entry.target, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
      if (!pending.size || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        applyMeasurements();
      });
    });
    for (const row of element.querySelectorAll("[data-row]")) {
      observer.observe(row);
      measure(row, row.getBoundingClientRect().height);
    }
    applyMeasurements();
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [element, rows, viewport.width, split, heights, estimates, start, end]);
  return { ref, attach, start, end, offsets, first, total: offsets[rows.length] };
}
