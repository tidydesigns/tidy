import { useEffect, useMemo, useRef, useState, type ReactNode, type DragEvent } from "react";
import { Button } from "@tidy/ui/button";
import type { ThreadSummary } from "../../shared/contracts";

export type ThreadOrderControls = {
  onDragStart(event: DragEvent<HTMLElement>): void;
  onDragEnd(): void;
  onMove(direction: -1 | 1): void;
};

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
  renderThread(thread: ThreadSummary, controls?: ThreadOrderControls): ReactNode;
}) {
  const [order, setOrder] = useState(() => readOrder(projectId));
  const dragging = useRef<string | null>(null);
  const [target, setTarget] = useState<{ id: string; after: boolean } | null>(null);
  const ordered = useMemo(() => {
    const known = new Set(order);
    const incoming = threads.filter((item) => !known.has(item.id)).map((item) => item.id);
    const ids = [...incoming, ...order];
    const ranks = new Map(ids.map((id, index) => [id, index]));
    return [...threads].sort((a, b) => (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0));
  }, [threads, order]);
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
  function move(id: string, to: string, after: boolean) {
    if (id === to) return;
    const ids = ordered.map((item) => item.id).filter((item) => item !== id);
    const index = ids.indexOf(to);
    if (index < 0) return;
    ids.splice(index + (after ? 1 : 0), 0, id);
    setOrder(ids);
  }
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
            <div
              key={item.id}
              className={`thread-order-row ${target?.id === item.id ? (target.after ? "drop-after" : "drop-before") : ""}`}
              onDragOver={(event) => {
                if (!dragging.current || dragging.current === item.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const bounds = event.currentTarget.getBoundingClientRect();
                setTarget({
                  id: item.id,
                  after: event.clientY > bounds.top + bounds.height / 2,
                });
              }}
              onDrop={(event) => {
                if (!dragging.current) return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                move(dragging.current, item.id, event.clientY > bounds.top + bounds.height / 2);
                dragging.current = null;
                setTarget(null);
              }}
            >
              {renderThread(item, {
                onDragStart(event) {
                  dragging.current = item.id;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", item.id);
                },
                onDragEnd() {
                  dragging.current = null;
                  setTarget(null);
                },
                onMove(direction) {
                  const neighbor = active[index + direction];
                  if (neighbor) move(item.id, neighbor.id, direction > 0);
                },
              })}
            </div>
          ))}
        </div>
      </div>
      {done.length > 0 && (
        <details className="done-threads">
          <summary>
            Done <span>{done.length}</span>
          </summary>
          <div className="done-thread-list">{done.map((item) => renderThread(item))}</div>
        </details>
      )}
    </div>
  );
}
