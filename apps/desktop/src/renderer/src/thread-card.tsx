import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { HarnessIcon } from "@tidy/ui/harness-icon";
import { relativeThreadTime } from "../../shared/thread-time";
import type { ThreadSummary } from "../../shared/contracts";
import type { ThreadOrderControls } from "./thread-sidebar";
import type { RepositoryContext } from "../../shared/repository-context";
import { ThreadPreview } from "./thread-preview";

export function ThreadCard({
  thread,
  selected,
  now,
  pending,
  onSelect,
  onDone,
  modelName,
  projectName,
  repository,
  orderControls,
}: {
  thread: ThreadSummary;
  selected: boolean;
  now: number;
  pending: boolean;
  onSelect(): void;
  onDone(): void;
  modelName?: string;
  projectName?: string;
  repository?: RepositoryContext;
  orderControls?: ThreadOrderControls;
}) {
  const working = thread.status === "running";
  const status = thread.doneAt
    ? "done"
    : thread.pendingApprovalCount
      ? "permission"
      : thread.status;
  const statusLabel = thread.doneAt
    ? "Done"
    : thread.pendingApprovalCount
      ? "Permission"
      : working
        ? "Working"
        : thread.status === "completed"
          ? "Ready"
          : thread.status === "failed"
            ? "Failed"
            : thread.status === "stopped"
              ? "Stopped"
              : thread.status === "interrupted"
                ? "Interrupted"
                : "Ready";
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null),
    preview = useRef<HTMLDivElement>(null);
  const id = useId();
  function close() {
    clearTimeout(timer.current);
    setOpen(false);
  }
  function show() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), 300);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open || !preview.current || !root.current) return;
    const popup = preview.current;
    popup.showPopover();
    const bounds = root.current.getBoundingClientRect(),
      size = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(bounds.right + 10, innerWidth - size.width - 8))}px`;
    popup.style.top = `${Math.max(8, Math.min(bounds.top, innerHeight - size.height - 8))}px`;
    const dismiss = () => setOpen(false);
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node && popup.contains(event.target))) dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div
      ref={root}
      className={`sidebar-item thread-item ${selected ? "selected" : ""} ${!working ? "can-change-status" : ""}`}
      onPointerDown={(event) => {
        close();
        orderControls?.onPointerDown(event);
      }}
      onPointerEnter={() => {
        if (!orderControls?.dragging) show();
      }}
      onPointerLeave={close}
      onBlur={(event) => {
        if (
          !(
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          )
        )
          close();
      }}
    >
      <Button
        className="thread-select"
        aria-keyshortcuts={orderControls ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        onKeyDown={(event) => {
          if (
            orderControls &&
            event.altKey &&
            (event.key === "ArrowUp" || event.key === "ArrowDown")
          ) {
            event.preventDefault();
            orderControls.onMove(event.key === "ArrowUp" ? -1 : 1);
          }
        }}
        aria-current={selected ? "true" : undefined}
        aria-describedby={open ? id : undefined}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) show();
        }}
        onClick={() => {
          close();
          onSelect();
        }}
      >
        <span className="thread-harness">
          <HarnessIcon harness={thread.harness} size={13} />
          <span>{thread.harness === "codex" ? "Codex" : "Claude Code"}</span>
        </span>
        <span className="thread-title">{thread.title}</span>
        <time
          className="thread-time"
          dateTime={thread.updatedAt}
          title={new Date(thread.updatedAt).toLocaleString()}
        >
          {relativeThreadTime(thread.updatedAt, now)}
        </time>
      </Button>
      <span
        className={`thread-card-status thread-state-${status}`}
        role="status"
        aria-label={statusLabel}
      >
        <span className="thread-status-symbol" aria-hidden="true">
          {status === "completed" || status === "done" ? (
            <svg viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" />
              <path d="m5 8 2 2 4-4" />
            </svg>
          ) : (
            <span />
          )}
        </span>
        {statusLabel}
      </span>
      {!working && (
        <Button
          className={`thread-done ${thread.doneAt ? "thread-reopen" : ""}`}
          onPointerEnter={close}
          onFocus={close}
          aria-label={`${thread.doneAt ? "Reopen thread" : "Mark done"}: ${thread.title}`}
          disabled={pending}
          title={thread.doneAt ? "Move back to active threads" : "Mark thread done"}
          onClick={() => {
            close();
            onDone();
          }}
        >
          {thread.doneAt ? "Reopen" : "Done"}
        </Button>
      )}
      {open && !orderControls?.dragging && (
        <div ref={preview} id={id} popover="manual" role="tooltip" className="thread-preview">
          <ThreadPreview
            thread={thread}
            projectName={projectName}
            repository={repository}
            modelName={modelName}
          />
        </div>
      )}
    </div>
  );
}
