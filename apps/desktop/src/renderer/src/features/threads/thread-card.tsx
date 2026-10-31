import { ChatLink } from "../../components/chat-link";
import type { DesktopAPI } from "../../../../shared/contracts/desktop";
import { harnessNames } from "../../../../shared/contracts/harness-updates";
import { codeFontClassName } from "../../styles/code-ui";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { ModelProviderIcon } from "../harnesses/model-provider-icon";
import { relativeThreadTime } from "./thread-time";
import type { ThreadSummary } from "../../../../shared/contracts/desktop";
import type { ThreadOrderControls } from "./thread-sidebar";
import type { RepositoryContext } from "../../../../shared/contracts/repository-context";
import { ThreadReadMarker } from "./thread-reading";
import { ThreadPreview } from "./thread-preview";

export function ThreadCard({
  thread,
  api,
  selected,
  loaded,
  now,
  pending,
  onSelect,
  onPreload,
  onDone,
  onRenameRequested,
  modelName,
  projectName,
  repository,
  orderControls,
}: {
  thread: ThreadSummary;
  api?: Pick<DesktopAPI, "openChatLink" | "browser" | "pullRequestState">;
  selected: boolean;
  loaded: boolean;
  now: number;
  pending: boolean;
  onSelect(): void;
  onPreload?(): void;
  onDone(): void;
  onRenameRequested?(): void;
  modelName?: string;
  projectName?: string;
  repository?: RepositoryContext;
  orderControls?: ThreadOrderControls;
}) {
  const working = thread.status === "running";
  const hasPullRequests = Boolean(api && thread.pullRequests?.length);
  const latestPullRequest = thread.pullRequests?.at(-1);
  const completionKey =
    thread.messageCount === undefined ? thread.updatedAt : `messages:${thread.messageCount}`;
  const visitKey = `tidy:thread-seen:${thread.projectId}:${thread.id}`;
  const [seenCompletion, setSeenCompletion] = useState<string | null>(() => {
    try {
      const saved = localStorage.getItem(visitKey);
      if (saved && /^\d{4}-/.test(saved) && thread.messageCount !== undefined)
        return `messages:${saved.slice(saved.lastIndexOf(":") + 1)}`;
      return saved;
    } catch {
      return null;
    }
  });
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
          : "Unread response";
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
    timer.current = setTimeout(() => {
      onPreload?.();
      setOpen(true);
    }, 150);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open || !preview.current || !root.current) return;
    const popup = preview.current;
    popup.showPopover();
    const bounds = root.current.getBoundingClientRect(),
      size = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(bounds.right + 6, innerWidth - size.width - 8))}px`;
    popup.style.top = `${Math.max(8, Math.min(bounds.top, innerHeight - size.height - 8))}px`;
    const dismiss = () => setOpen(false);
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node && popup.contains(event.target))) dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (popup.contains(document.activeElement))
          root.current
            ?.querySelector<HTMLButtonElement>(".thread-select")
            ?.focus({ preventScroll: true });
        dismiss();
      }
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
      className={`thread-item can-change-status relative mb-[3px] block w-full cursor-pointer overflow-hidden rounded-md border border-transparent p-0 text-left text-[13px] leading-[1.5] text-ellipsis whitespace-nowrap text-ink hover:border-border ${selected ? "selected bg-subtle-fill hover:bg-subtle-fill" : "bg-transparent hover:bg-hover-surface"}`}
      data-quiet={status === "idle" && !selected ? "true" : undefined}
      onPointerDown={(event) => {
        close();
        orderControls?.onPointerDown(event);
      }}
      onPointerEnter={(event) => {
        if (event.target instanceof Node && preview.current?.contains(event.target)) {
          clearTimeout(timer.current);
          return;
        }
        if (event.pointerType === "mouse" && !orderControls?.dragging) {
          show();
        }
      }}
      onPointerLeave={(event) => {
        clearTimeout(timer.current);
        if (open && !event.currentTarget.contains(document.activeElement))
          timer.current = setTimeout(close, 150);
      }}
      onBlur={(event) => {
        if (
          !(
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          )
        )
          close();
      }}
    >
      {selected && loaded && thread.status === "completed" && (
        <ThreadReadMarker
          visitKey={visitKey}
          completionKey={completionKey}
          onSeen={setSeenCompletion}
        />
      )}
      <Button
        className="thread-select flex w-full cursor-pointer flex-col gap-0.5 rounded-[inherit] border-0 bg-transparent px-2 py-2.5 text-left text-[13px] leading-5 text-inherit"
        aria-keyshortcuts={orderControls ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        onKeyDown={(event) => {
          if (event.key === "F2" && onRenameRequested) {
            event.preventDefault();
            onSelect();
            onRenameRequested();
            return;
          }
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
        aria-describedby={open && !hasPullRequests ? id : undefined}
        aria-controls={open && hasPullRequests ? id : undefined}
        aria-expanded={hasPullRequests ? open : undefined}
        onFocus={(event) => {
          onPreload?.();
          if (event.currentTarget.matches(":focus-visible")) {
            clearTimeout(timer.current);
            setOpen(true);
          }
        }}
        onClick={() => {
          close();
          onSelect();
        }}
      >
        <span
          onDoubleClick={(event) => {
            event.stopPropagation();
            close();
            onRenameRequested?.();
          }}
          className={`thread-title block w-full truncate text-sm leading-5 font-medium ${thread.doneAt ? "pr-16" : "pr-12"} ${status === "idle" && !selected ? "text-[light-dark(#424242,#d4d4d4)]" : ""}`}
        >
          {thread.title}
        </span>
        <span
          className="thread-harness flex h-[18px] w-3.5 items-center text-xs leading-[18px] text-muted-ink"
          role="img"
          aria-label={harnessNames[thread.harness]}
          title={harnessNames[thread.harness]}
        >
          <ModelProviderIcon harness={thread.harness} size={14} />
        </span>
        <time
          className="thread-time absolute top-2.5 right-2 text-[11px] leading-5 text-muted-ink tabular-nums"
          dateTime={thread.updatedAt}
          title={new Date(thread.updatedAt).toLocaleString()}
        >
          {relativeThreadTime(thread.updatedAt, now)}
        </time>
      </Button>
      <div className="thread-card-trailing pointer-events-none absolute top-8 right-2 left-7 grid grid-cols-[minmax(0,1fr)_64px] items-center gap-2">
        {api && latestPullRequest && (
          <span
            className="thread-pull-requests pointer-events-auto col-start-1 flex min-w-0 max-w-full justify-self-start items-center gap-1 text-[11px] leading-[18px] text-muted-ink tabular-nums"
            aria-label="Thread pull requests"
            onPointerDown={(event) => event.stopPropagation()}
            onFocus={() => {
              clearTimeout(timer.current);
              setOpen(true);
            }}
          >
            <ChatLink href={latestPullRequest} api={api} projectId={thread.projectId}>
              {`#${latestPullRequest.split("/").at(-1)}`}
            </ChatLink>
            {thread.pullRequests && thread.pullRequests.length > 1 && (
              <span
                className="shrink-0"
                aria-label={`${thread.pullRequests.length - 1} more pull requests`}
              >
                +{thread.pullRequests.length - 1}
              </span>
            )}
          </span>
        )}
        {status !== "idle" && (
          <span
            className={`thread-card-status thread-state-${status} pointer-events-none col-start-2 flex shrink-0 items-center justify-self-end gap-[5px] text-[11px] leading-[1.5] ${status === "running" ? "text-(--desktop-status-active)" : status === "permission" ? "text-(--desktop-status-warning)" : status === "failed" ? "text-(--desktop-status-danger)" : "text-[light-dark(#15803d,#4caf50)]"}`}
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
      </div>
      <Button
        className={`thread-done absolute top-[7px] right-2 flex h-[22px] min-h-[26px] min-w-11 cursor-pointer items-center justify-center gap-[3px] rounded border-0 bg-transparent px-1.5 py-[3px] text-[11px] leading-[1.5] text-muted-ink hover:text-[light-dark(#292929,#ffffff)] ${thread.doneAt ? "thread-reopen w-14" : "w-10"}`}
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
        <div
          ref={preview}
          id={id}
          popover="manual"
          role={hasPullRequests ? "dialog" : "tooltip"}
          aria-label={hasPullRequests ? `${thread.title} details` : undefined}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerEnter={() => clearTimeout(timer.current)}
          className={`thread-preview fixed inset-auto m-0 max-h-[calc(100vh_-_16px)] w-max max-w-[min(20rem,calc(100vw_-_16px))] overflow-auto rounded-lg border border-border bg-panel p-3 text-xs whitespace-normal text-ink shadow-[0_4px_16px_rgb(0_0_0_/_12%)] ${codeFontClassName}`}
        >
          <ThreadPreview
            thread={thread}
            api={api}
            projectName={projectName}
            repository={repository}
            modelName={modelName}
          />
        </div>
      )}
    </div>
  );
}
