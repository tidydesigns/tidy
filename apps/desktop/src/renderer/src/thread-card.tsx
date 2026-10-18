import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { HarnessIcon } from "@tidy/ui/harness-icon";
import { relativeThreadTime } from "../../shared/thread-time";
import type { ThreadSummary } from "../../shared/contracts";
import { TokenUsageDetails } from "./harness-controls";

export function ThreadCard({
  thread,
  selected,
  now,
  pending,
  onSelect,
  onDone,
  modelName,
  designNames,
}: {
  thread: ThreadSummary;
  selected: boolean;
  now: number;
  pending: boolean;
  onSelect(): void;
  onDone(): void;
  modelName?: string;
  designNames: string[];
}) {
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
      className={`sidebar-item thread-item ${selected ? "selected" : ""}`}
      onPointerEnter={show}
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
        <span className="thread-meta">
          <span
            className="thread-harness"
            role="img"
            aria-label={thread.harness === "codex" ? "Codex" : "Claude Code"}
          >
            <HarnessIcon harness={thread.harness} size={14} />
            {thread.status === "running" && <span>Running</span>}
          </span>
          <time dateTime={thread.updatedAt} title={new Date(thread.updatedAt).toLocaleString()}>
            {relativeThreadTime(thread.updatedAt, now)}
          </time>
        </span>
      </Button>
      <Button
        className="thread-done"
        aria-label={`${thread.doneAt ? "Reopen" : "Mark done:"} ${thread.title}`}
        aria-pressed={Boolean(thread.doneAt)}
        disabled={pending || thread.status === "running"}
        title={
          thread.status === "running"
            ? "Wait for this run to finish"
            : thread.doneAt
              ? "Reopen thread"
              : "Mark thread done"
        }
        onClick={() => {
          close();
          onDone();
        }}
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path
            d="m3 8 3 3 7-7"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Done
      </Button>
      {open && (
        <div ref={preview} id={id} popover="manual" role="tooltip" className="thread-preview">
          <strong>{thread.title}</strong>
          <div className="thread-preview-model">
            <HarnessIcon harness={thread.harness} />
            <span>
              {modelName ?? thread.settings?.model ?? thread.actualModel ?? "Default model"}
              {thread.settings?.effort ? ` · ${thread.settings.effort} effort` : ""}
            </span>
          </div>
          <div className="thread-preview-status">
            <span>
              {thread.doneAt
                ? "Done"
                : thread.status === "completed"
                  ? "Ready"
                  : thread.status.charAt(0).toUpperCase() + thread.status.slice(1)}
            </span>
            <span>{thread.messageCount ?? 0} messages</span>
          </div>
          {thread.preview && <p className="thread-preview-message">{thread.preview}</p>}
          {designNames.length > 0 && (
            <p className="thread-preview-designs">Designs: {designNames.join(", ")}</p>
          )}
          {thread.usage && <TokenUsageDetails usage={thread.usage} />}
          <time dateTime={thread.updatedAt}>
            Last activity {new Date(thread.updatedAt).toLocaleString()}
          </time>
        </div>
      )}
    </div>
  );
}
