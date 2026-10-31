import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@tidy/editor/components/ui/icon";
import { SelectMenu } from "@tidy/ui/select-menu";
import type { ThreadSummary } from "../../../../shared/contracts/desktop";

export function ThreadTitle({
  thread,
  generating,
  editRequested,
  onEditFinished,
  onRename,
  onRegenerate,
}: {
  thread: ThreadSummary;
  generating: boolean;
  editRequested: boolean;
  onEditFinished(): void;
  onRename(thread: ThreadSummary, title: string): void;
  onRegenerate(thread: ThreadSummary): void;
}) {
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
          title="Double-click to rename"
          className="m-0 min-w-0 truncate rounded text-sm leading-[1.5] font-medium outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          onDoubleClick={edit}
          onKeyDown={(event) => {
            if (event.key === "F2" || event.key === "Enter") {
              event.preventDefault();
              edit();
            }
          }}
        >
          {thread.title}
        </h1>
      )}
      <SelectMenu
        value=""
        label="Thread name actions"
        actionMenu
        size="sm"
        className="shrink-0"
        triggerClassName="grid size-7 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted-ink hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        triggerContent={<Icon name="more" size={16} />}
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
