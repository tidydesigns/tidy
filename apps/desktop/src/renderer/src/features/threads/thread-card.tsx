import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { HarnessIcon } from "@tidy/ui/harness-icon";
import { relativeThreadTime } from "./thread-time";
import type { ThreadSummary } from "../../../../shared/contracts/desktop";
import type { ThreadOrderControls } from "./thread-sidebar";
import type { RepositoryContext } from "../../../../shared/contracts/repository-context";
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
  const completionKey = `${thread.updatedAt}:${thread.messageCount ?? 0}`;
  const visitKey = `tidy:thread-seen:${thread.projectId}:${thread.id}`;
  const [seenCompletion, setSeenCompletion] = useState<string | null>(() => {
    try {
      return localStorage.getItem(visitKey);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!selected || thread.status !== "completed") return;
    function markSeen() {
      if (document.visibilityState !== "visible") return;
      setSeenCompletion(completionKey);
      try {
        localStorage.setItem(visitKey, completionKey);
      } catch {}
    }
    markSeen();
    document.addEventListener("visibilitychange", markSeen);
    return () => document.removeEventListener("visibilitychange", markSeen);
  }, [selected, thread.status, completionKey, visitKey]);
  const status = thread.doneAt
    ? "idle"
    : thread.pendingApprovalCount
      ? "permission"
      : working
        ? "running"
        : thread.status === "failed"
          ? "failed"
          : thread.status === "completed" && !selected && seenCompletion !== completionKey
            ? "completed"
            : "idle";
  const statusLabel =
    status === "permission"
      ? "Approval"
      : status === "running"
        ? "Working"
        : status === "failed"
          ? "Failed"
          : "New response";
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
      className={`sidebar-item thread-item can-change-status ${selected ? "selected" : ""}`}
      data-quiet={status === "idle" && !selected ? "true" : undefined}
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
        <span className="thread-title">{thread.title}</span>
        <span className="thread-harness">
          {thread.harness === "codex" ? (
            <span
              className="model-provider-icon"
              style={{ width: 13, height: 13 }}
              aria-hidden="true"
            />
          ) : (
            <HarnessIcon harness={thread.harness} size={13} />
          )}
          <span
            className="thread-provider-name"
            title={thread.harness === "codex" ? "Codex" : "Claude Code"}
          >
            {thread.harness === "codex" ? "Codex" : "Claude"}
          </span>
          {projectName && (
            <>
              <span className="thread-project-separator" aria-hidden="true">
                ·
              </span>
              <span className="thread-project" title={projectName}>
                {projectName}
              </span>
            </>
          )}
        </span>
        <time
          className="thread-time"
          dateTime={thread.updatedAt}
          title={new Date(thread.updatedAt).toLocaleString()}
        >
          {relativeThreadTime(thread.updatedAt, now)}
        </time>
      </Button>
      {status !== "idle" && (
        <span
          className={`thread-card-status thread-state-${status}`}
          role="status"
          aria-label={statusLabel}
          title={statusLabel}
        >
          <span className="thread-status-symbol" aria-hidden="true">
            {status === "completed" ? (
              <svg viewBox="0 0 16 16">
                <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" />
                <path className="thread-ready-check" d="m4.8 8 2.1 2.1 4.2-4.3" fill="none" />
              </svg>
            ) : status === "running" ? (
              <span />
            ) : (
              <svg viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 4.5v4" />
                <circle cx="8" cy="11" r="0.7" fill="currentColor" stroke="none" />
              </svg>
            )}
          </span>
          {status !== "completed" && statusLabel}
        </span>
      )}
      <Button
        className={`thread-done ${thread.doneAt ? "thread-reopen" : ""}`}
        onPointerEnter={close}
        onFocus={close}
        aria-label={`${thread.doneAt ? "Reopen thread" : "Mark done"}: ${thread.title}`}
        disabled={pending}
        title={
          thread.doneAt
            ? "Move back to active threads"
            : working
              ? "Stop thread and mark done"
              : "Mark thread done"
        }
        onClick={() => {
          close();
          onDone();
        }}
      >
        {thread.doneAt ? "Reopen" : "Done"}
      </Button>
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
