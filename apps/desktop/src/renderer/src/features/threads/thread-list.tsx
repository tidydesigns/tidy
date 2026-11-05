import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import type { ThreadSummary } from "../../../../shared/contracts/desktop";

const focusable =
  'button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])';
function controls(row: Element) {
  return [...row.querySelectorAll<HTMLElement>(focusable)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      getComputedStyle(element).visibility !== "hidden" &&
      element.getClientRects().length > 0,
  );
}

export function ThreadList({
  threads,
  renderRow,
  className,
  listClassName,
  listRef,
  draggingId,
  onClickCapture,
  children,
  leading,
}: {
  threads: ThreadSummary[];
  renderRow(thread: ThreadSummary, index: number): ReactNode;
  className: string;
  listClassName: string;
  listRef?: RefObject<HTMLDivElement | null>;
  draggingId?: string | null;
  onClickCapture?: ComponentProps<"div">["onClickCapture"];
  children?: ReactNode;
  leading?: ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const ownList = useRef<HTMLDivElement>(null);
  const list = listRef ?? ownList;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const virtual = threads.length > 200;
  const [inset, setInset] = useState(0);
  useLayoutEffect(() => {
    const element = list.current;
    if (!virtual || !element) return;
    const header = leading ? element.firstElementChild : null;
    const measure = () => {
      const padding = parseFloat(getComputedStyle(element).paddingTop) || 0;
      const margin = header ? parseFloat(getComputedStyle(header).marginBottom) || 0 : 0;
      setInset(padding + (header?.getBoundingClientRect().height ?? 0) + margin);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (header) observer.observe(header);
    return () => observer.disconnect();
  }, [virtual, leading, list]);
  const getItemKey = useCallback((index: number) => threads[index].id, [threads]);
  const focusedIndex = threads.findIndex((thread) => thread.id === focusedId);
  const draggedIndex = threads.findIndex((thread) => thread.id === draggingId);
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indices = new Set(defaultRangeExtractor(range));
      if (focusedIndex >= 0) indices.add(focusedIndex);
      if (draggedIndex >= 0) indices.add(draggedIndex);
      return [...indices].sort((a, b) => a - b);
    },
    [focusedIndex, draggedIndex],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: threads.length,
    paddingStart: inset,
    getScrollElement: () => scroll.current,
    estimateSize: () => 100,
    getItemKey,
    rangeExtractor,
    overscan: 6,
    enabled: virtual,
  });
  const rows = virtual
    ? virtualizer.getVirtualItems().map((row) => ({ index: row.index, top: row.start }))
    : threads.map((_, index) => ({ index, top: 0 }));

  return (
    <div className={className} ref={scroll}>
      {children}
      <div
        ref={list}
        className={listClassName}
        role="list"
        style={virtual ? { position: "relative", height: virtualizer.getTotalSize() } : undefined}
        onClickCapture={onClickCapture}
        onFocusCapture={(event) => {
          if (event.target instanceof Element)
            setFocusedId(
              event.target.closest<HTMLElement>("[data-thread-id]")?.dataset.threadId ?? null,
            );
        }}
        onBlurCapture={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setFocusedId(null);
        }}
        onKeyDown={(event) => {
          if (
            !virtual ||
            event.key !== "Tab" ||
            event.ctrlKey ||
            event.altKey ||
            event.metaKey ||
            !(event.target instanceof HTMLElement)
          )
            return;
          const row = event.target.closest<HTMLElement>("[data-thread-id]");
          if (!row) return;
          const buttons = controls(row);
          if (event.target !== (event.shiftKey ? buttons[0] : buttons.at(-1))) return;
          const index = threads.findIndex((thread) => thread.id === row.dataset.threadId);
          const next = index + (event.shiftKey ? -1 : 1);
          if (index < 0 || next < 0 || next >= threads.length) return;
          event.preventDefault();
          flushSync(() => setFocusedId(threads[next].id));
          virtualizer.scrollToIndex(next, { align: "auto" });
          const destination = list.current?.querySelector(`[data-thread-id="${threads[next].id}"]`);
          const targets = destination ? controls(destination) : [];
          (event.shiftKey ? targets.at(-1) : targets[0])?.focus({ preventScroll: true });
        }}
      >
        {leading}
        {rows.map(({ index, top }) => (
          <div
            key={threads[index].id}
            ref={virtual ? virtualizer.measureElement : undefined}
            data-index={index}
            data-thread-id={threads[index].id}
            className={listRef ? "thread-order-row" : undefined}
            role="listitem"
            aria-posinset={index + 1}
            aria-setsize={threads.length}
            style={
              virtual
                ? { position: "absolute", top, left: 0, right: 0, display: "flow-root" }
                : undefined
            }
          >
            {renderRow(threads[index], index)}
          </div>
        ))}
      </div>
    </div>
  );
}
