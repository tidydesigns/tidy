import { useLayoutEffect, useRef, useState } from "react";
import { SelectMenu } from "@tidy/ui/select-menu";
import { Button } from "@tidy/ui/button";
import type { ThreadSummary } from "../../../../shared/contracts/desktop";

type ThreadTitleProps = {
  thread: ThreadSummary;
  generating: boolean;
  editRequested: boolean;
  onEditFinished(): void;
  onRename(thread: ThreadSummary, title: string): void;
  onRegenerate(thread: ThreadSummary): void;
};

export function ThreadTitle({
  parent,
  ...props
}: ThreadTitleProps & {
  parent?: {
    title: string;
    open(): void;
    prefetch(): void;
  };
}) {
  const container = useRef<HTMLDivElement>(null);
  const returning = useRef(false);
  useLayoutEffect(() => {
    if (!returning.current) return;
    returning.current = false;
    container.current?.querySelector("h1")?.focus({ preventScroll: true });
  }, [props.thread.id]);
  const title = <ThreadTitleEditor key={props.thread.id} {...props} />;
  const parentTitle = parent?.title.trim() || "Parent thread";
  return (
    <div ref={container} className="min-w-0 max-w-full flex-1">
      {parent ? (
        <nav
          className="thread-breadcrumb min-w-0 text-sm leading-[1.5]"
          aria-label="Thread breadcrumb"
        >
          <ol className="m-0 flex min-w-0 list-none items-center gap-2 p-0">
            <li className="min-w-6 max-w-[45%] flex-initial">
              <Button
                className="agent-parent block min-w-6 max-w-full cursor-pointer truncate rounded border-0 bg-transparent px-0.5 py-1 text-start text-muted-ink hover:bg-hover-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                title={parentTitle}
                onPointerEnter={parent.prefetch}
                onFocus={parent.prefetch}
                onClick={() => {
                  returning.current = true;
                  parent.open();
                }}
              >
                <bdi>{parentTitle}</bdi>
              </Button>
            </li>
            <li className="flex-none text-muted-ink" aria-hidden="true">
              /
            </li>
            <li className="min-w-0 flex-initial" aria-current="page">
              {title}
            </li>
          </ol>
        </nav>
      ) : (
        title
      )}
    </div>
  );
}

function ThreadTitleEditor({
  thread,
  generating,
  editRequested,
  onEditFinished,
  onRename,
  onRegenerate,
}: ThreadTitleProps) {
  const title = thread.title.trim() || "New thread";
  const [editing, setEditing] = useState(editRequested);
  const [draft, setDraft] = useState(thread.title);
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const finished = useRef(false);
  function edit() {
    finished.current = false;
    setDraft(thread.title);
    setEditing(true);
  }
  useLayoutEffect(() => {
    if (editRequested) {
      finished.current = false;
      setDraft(thread.title);
      setEditing(true);
    }
  }, [editRequested]); // Capture the name when editing starts, not on background title updates.
  useLayoutEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  function finish(cancel = false, restoreFocus = false) {
    if (finished.current) return;
    finished.current = true;
    const title = draft.replace(/[\x00-\x1f\x7f]/g, " ").trim();
    if (!cancel && title && (title !== thread.title || thread.titleSource !== "manual"))
      onRename(thread, title);
    setEditing(false);
    onEditFinished();
    if (restoreFocus) requestAnimationFrame(() => heading.current?.focus());
  }
  return (
    <div className="flex min-w-0 items-center gap-1">
      {editing ? (
        <input
          ref={input}
          aria-label="Thread name"
          value={draft}
          maxLength={120}
          className="min-w-0 flex-1 rounded border border-border bg-panel px-1 py-0.5 text-sm leading-[1.5] font-medium text-ink outline-none focus:border-focus-ring"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => finish()}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              finish(event.key === "Escape", true);
            }
          }}
        />
      ) : (
        <h1
          ref={heading}
          tabIndex={0}
          title={`${title}\nDouble-click to rename`}
          className="m-0 min-w-0 truncate rounded text-sm leading-[1.5] font-medium outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          onDoubleClick={edit}
          onKeyDown={(event) => {
            if (event.key === "F2" || event.key === "Enter") {
              event.preventDefault();
              edit();
            }
          }}
        >
          <bdi>{title}</bdi>
        </h1>
      )}
      <SelectMenu
        value=""
        label="Thread name actions"
        actionMenu
        size="sm"
        className="shrink-0"
        triggerClassName="grid size-7 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted-ink hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        triggerContent={
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="thread-name-dots pointer-events-none"
            data-generating={generating || undefined}
          >
            <circle cx="4" cy="12" r="1.25" />
            <circle cx="12" cy="12" r="1.25" />
            <circle cx="20" cy="12" r="1.25" />
          </svg>
        }
        options={[
          { value: "rename", label: "Rename" },
          {
            value: "regenerate",
            label: generating ? "Generating name…" : "Regenerate name",
            disabled: generating,
          },
        ]}
        onChange={(action) => {
          if (action === "rename") edit();
          else if (action === "regenerate") onRegenerate(thread);
        }}
      />
      {generating && (
        <span className="sr-only" role="status">
          Generating thread name
        </span>
      )}
    </div>
  );
}
