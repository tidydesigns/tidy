import { memo, useEffect, useMemo, useState, type ReactNode, type PointerEvent } from "react";
import { z } from "zod";
import { DraftThreadCard } from "./draft-thread-card";
import { useThreadDrag } from "./use-thread-drag";
import { useDraftSidebarMotion } from "./use-draft-sidebar-motion";
import type { ThreadSummary } from "../../../../shared/contracts/desktop";

export type ThreadOrderControls = {
  onPointerDown(event: PointerEvent<HTMLElement>): void;
  dragging: boolean;
  onMove(direction: -1 | 1): void;
};

type RenderThread = (thread: ThreadSummary, controls?: ThreadOrderControls) => ReactNode;
const ThreadRow = memo(function ThreadRow({
  thread,
  previousId,
  nextId,
  dragging,
  filtered,
  onPointerDown,
  move,
  renderThread,
}: {
  thread: ThreadSummary;
  previousId?: string;
  nextId?: string;
  dragging: boolean;
  filtered: boolean;
  onPointerDown: ReturnType<typeof useThreadDrag>["onPointerDown"];
  move: ReturnType<typeof useThreadDrag>["move"];
  renderThread: RenderThread;
}) {
  return (
    <div className="thread-order-row" data-thread-id={thread.id}>
      {renderThread(
        thread,
        filtered
          ? undefined
          : {
              dragging,
              onPointerDown(event) {
                onPointerDown({ event, id: thread.id });
              },
              onMove(direction) {
                const neighbor = direction < 0 ? previousId : nextId;
                if (neighbor) move({ id: thread.id, to: neighbor, after: direction > 0 });
              },
            },
      )}
    </div>
  );
});

const DoneThreadRow = memo(function DoneThreadRow({
  thread,
  renderThread,
}: {
  thread: ThreadSummary;
  renderThread: RenderThread;
}) {
  return renderThread(thread);
});

const threadOrderSchema = z.array(z.string()).transform((ids) => ids.slice(0, 1000));

function readOrder(projectId: string): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`tidy:thread-order:${projectId}`) ?? "[]",
    );
    return threadOrderSchema.parse(value);
  } catch {
    return [];
  }
}

export const ThreadSidebar = memo(function ThreadSidebar({
  projectId,
  threads,
  search,
  renderThread,
  draft,
  complete = true,
}: {
  projectId: string;
  threads: ThreadSummary[];
  search: string;
  renderThread: RenderThread;
  draft?: { text: string; selected: boolean; onSelect(): void };
  complete?: boolean;
}) {
  const roots = useMemo(() => threads.filter((thread) => !thread.parentThreadId), [threads]);
  const [order, setOrder] = useState(() => readOrder(projectId));
  const orderedIds = useMemo(() => {
    const known = new Set(order);
    const incoming = roots.filter((item) => !known.has(item.id)).map((item) => item.id);
    return [...incoming, ...order];
  }, [roots, order]);
  const ordered = useMemo(() => {
    const ranks = new Map(orderedIds.map((id, index) => [id, index]));
    return [...roots].sort((a, b) => (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0));
  }, [roots, orderedIds]);
  const drag = useThreadDrag({
    ids: complete ? ordered.map((item) => item.id) : orderedIds,
    setOrder,
  });
  useEffect(() => {
    if (!complete) return;
    const ids = ordered.map((item) => item.id);
    if (ids.length !== order.length || ids.some((id, index) => id !== order[index])) setOrder(ids);
  }, [ordered, order, complete]);
  useEffect(() => {
    if (drag.draggingId || (!complete && !order.length)) return;
    try {
      const key = `tidy:thread-order:${projectId}`;
      const value = JSON.stringify(order);
      if (localStorage.getItem(key) !== value) localStorage.setItem(key, value);
    } catch {
      /* A private browser may disable preference storage. */
    }
  }, [projectId, order, drag.draggingId, complete]);
  const query = search.trim().toLocaleLowerCase();
  const matches = (item: ThreadSummary) =>
    (item.title.trim() || "New thread").toLocaleLowerCase().includes(query);
  const visibleDraft = Boolean(
    draft?.text.trim() && draft.text.toLocaleLowerCase().includes(query),
  );
  const active = ordered.filter((item) => !item.doneAt && matches(item));
  useDraftSidebarMotion({
    list: drag.list,
    visible: visibleDraft,
    scope: `${projectId}:${query}`,
    order: active.map((item) => item.id).join(":"),
    dragging: Boolean(drag.draggingId),
  });
  const done = roots
    .filter((item) => item.doneAt && matches(item))
    .sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  return (
    <div
      className="project-sidebar flex min-h-0 min-w-0 flex-1 flex-col px-2 pb-2"
      role="region"
      aria-label="Threads"
    >
      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]">
        {query && !visibleDraft && active.length === 0 && done.length === 0 && (
          <p
            className="thread-search-empty mx-2.5 my-2 text-xs leading-[18px] text-muted-ink"
            role="status"
          >
            No matching threads
          </p>
        )}
        <div
          className="sidebar-list relative min-h-0 flex-1 overflow-visible pt-2"
          ref={drag.list}
          onClickCapture={drag.onClickCapture}
        >
          {visibleDraft && draft && <DraftThreadCard {...draft} />}
          {active.map((item, index) => (
            <ThreadRow
              key={item.id}
              thread={item}
              previousId={active[index - 1]?.id}
              nextId={active[index + 1]?.id}
              dragging={drag.draggingId === item.id}
              filtered={Boolean(query)}
              onPointerDown={drag.onPointerDown}
              move={drag.move}
              renderThread={renderThread}
            />
          ))}
        </div>
        {done.length > 0 && (
          <details
            className="done-threads group/done mt-2 border-t border-border"
            open={query ? true : undefined}
          >
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-[9px] py-2.5 text-xs leading-[1.5] text-muted-ink [&::-webkit-details-marker]:hidden">
              <span
                aria-hidden="true"
                className="inline-flex w-3.5 shrink-0 justify-center group-open/done:rotate-90"
              >
                ›
              </span>
              Done <span className="text-[11px] tabular-nums">{done.length}</span>
            </summary>
            <div className="done-thread-list pt-1">
              {done.map((item) => (
                <DoneThreadRow key={item.id} thread={item} renderThread={renderThread} />
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
});
