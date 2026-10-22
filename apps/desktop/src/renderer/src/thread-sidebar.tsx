import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type DragEvent,
  type RefObject,
} from "react";
import { Button } from "@tidy/ui/button";
import type { ThreadSummary } from "../../shared/contracts";

export type ThreadOrderControls = {
  onDragStart(event: DragEvent<HTMLElement>): void;
  onDragEnd(): void;
  onMove(direction: -1 | 1): void;
};

type RenderThread = (thread: ThreadSummary, controls?: ThreadOrderControls) => ReactNode;
type DropTarget = { id: string; after: boolean } | null;

const ThreadRow = memo(function ThreadRow({
  thread,
  previousId,
  nextId,
  dropPosition,
  dragging,
  setTarget,
  move,
  renderThread,
}: {
  thread: ThreadSummary;
  previousId?: string;
  nextId?: string;
  dropPosition: "before" | "after" | null;
  dragging: RefObject<string | null>;
  setTarget(target: DropTarget): void;
  move(id: string, to: string, after: boolean): void;
  renderThread: RenderThread;
}) {
  return (
    <div
      className={`thread-order-row ${dropPosition ? `drop-${dropPosition}` : ""}`}
      onDragOver={(event) => {
        if (!dragging.current || dragging.current === thread.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const bounds = event.currentTarget.getBoundingClientRect();
        setTarget({ id: thread.id, after: event.clientY > bounds.top + bounds.height / 2 });
      }}
      onDrop={(event) => {
        if (!dragging.current) return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        move(dragging.current, thread.id, event.clientY > bounds.top + bounds.height / 2);
        dragging.current = null;
        setTarget(null);
      }}
    >
      {renderThread(thread, {
        onDragStart(event) {
          dragging.current = thread.id;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", thread.id);
        },
        onDragEnd() {
          dragging.current = null;
          setTarget(null);
        },
        onMove(direction) {
          const neighbor = direction < 0 ? previousId : nextId;
          if (neighbor) move(thread.id, neighbor, direction > 0);
        },
      })}
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

function readOrder(projectId: string): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`tidy:thread-order:${projectId}`) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string").slice(0, 1000)
      : [];
  } catch {
    return [];
  }
}

export function ThreadSidebar({
  projectId,
  threads,
  onNew,
  renderThread,
}: {
  projectId: string;
  threads: ThreadSummary[];
  onNew(): void;
  renderThread: RenderThread;
}) {
  const [order, setOrder] = useState(() => readOrder(projectId));
  const dragging = useRef<string | null>(null);
  const [target, setTarget] = useState<DropTarget>(null);
  const ordered = useMemo(() => {
    const known = new Set(order);
    const incoming = threads.filter((item) => !known.has(item.id)).map((item) => item.id);
    const ids = [...incoming, ...order];
    const ranks = new Map(ids.map((id, index) => [id, index]));
    return [...threads].sort((a, b) => (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0));
  }, [threads, order]);
  const committedOrder = useRef<string[]>([]);
  useLayoutEffect(() => {
    committedOrder.current = ordered.map((item) => item.id);
  }, [ordered]);
  useEffect(() => {
    const ids = ordered.map((item) => item.id);
    if (ids.length !== order.length || ids.some((id, index) => id !== order[index])) setOrder(ids);
  }, [ordered, order]);
  useEffect(() => {
    try {
      localStorage.setItem(`tidy:thread-order:${projectId}`, JSON.stringify(order));
    } catch {
      /* A private browser may disable preference storage. */
    }
  }, [projectId, order]);
  const active = ordered.filter((item) => !item.doneAt);
  const done = threads
    .filter((item) => item.doneAt)
    .sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  const move = useCallback((id: string, to: string, after: boolean) => {
    if (id === to) return;
    const ids = committedOrder.current.filter((item) => item !== id);
    const index = ids.indexOf(to);
    if (index < 0) return;
    ids.splice(index + (after ? 1 : 0), 0, id);
    setOrder(ids);
  }, []);
  return (
    <div className="project-sidebar" aria-label="Threads">
      <div className="sidebar-heading">
        <span>Threads</span>
        <Button className="quiet-button" onClick={onNew}>
          New thread
        </Button>
      </div>
      <div className="sidebar-scroll">
        <div className="sidebar-list">
          {active.map((item, index) => (
            <ThreadRow
              key={item.id}
              thread={item}
              previousId={active[index - 1]?.id}
              nextId={active[index + 1]?.id}
              dropPosition={target?.id === item.id ? (target.after ? "after" : "before") : null}
              dragging={dragging}
              setTarget={setTarget}
              move={move}
              renderThread={renderThread}
            />
          ))}
        </div>
      </div>
      {done.length > 0 && (
        <details className="done-threads">
          <summary>
            Done <span>{done.length}</span>
          </summary>
          <div className="done-thread-list">
            {done.map((item) => (
              <DoneThreadRow key={item.id} thread={item} renderThread={renderThread} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
