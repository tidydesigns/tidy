"use client";
import { useState, useSyncExternalStore } from "react";
import { textLinkSchema } from "@tidy/design/rich-text";
import type { TextCommand, TextFormatting } from "../design/text-formatting";

type Snapshot = TextFormatting & { nodeId: string };
let snapshot: Snapshot | null = null;
let session: { root: HTMLElement; range?: Range; change: () => void } | null = null;
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const serverSnapshot = () => null;
export function useRichTextSelection() {
  return useSyncExternalStore(subscribe, () => snapshot, serverSnapshot);
}

export function registerRichTextSelection(root: HTMLElement, nodeId: string, change: () => void) {
  const active: NonNullable<typeof session> = { root, change };
  session = active;
  const update = () => {
    const selection = window.getSelection();
    if (session !== active || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    active.range = range.cloneRange();
    const mark = (command: TextCommand) =>
      document.queryCommandIndeterm(command) ? "mixed" : document.queryCommandState(command);
    const marks: Snapshot["marks"] = {
      bold: mark("bold"),
      italic: mark("italic"),
      underline: mark("underline"),
      strikeThrough: mark("strikeThrough"),
      insertUnorderedList: mark("insertUnorderedList"),
      insertOrderedList: mark("insertOrderedList"),
      createLink: mark("createLink"),
      unlink: mark("unlink"),
    };
    const element =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode?.parentElement;
    const href = element?.closest("a")?.getAttribute("href") ?? "";
    const next = { nodeId, marks, href };
    if (JSON.stringify(snapshot) !== JSON.stringify(next)) {
      snapshot = next;
      publish();
    }
  };
  document.addEventListener("selectionchange", update);
  root.addEventListener("input", update);
  update();
  return () => {
    document.removeEventListener("selectionchange", update);
    root.removeEventListener("input", update);
    if (session === active) {
      session = null;
      snapshot = null;
      publish();
    }
  };
}

export function applyTextCommand(command: TextCommand, value?: string) {
  if (!session?.range || (command === "createLink" && !textLinkSchema.safeParse(value).success))
    return;
  const active = session,
    range = session.range,
    selection = window.getSelection();
  const focused = document.activeElement;
  const liveRange = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  if (
    liveRange &&
    active.root.contains(liveRange.startContainer) &&
    active.root.contains(liveRange.endContainer)
  )
    active.range = liveRange.cloneRange();
  active.root.focus({ preventScroll: true });
  selection?.removeAllRanges();
  selection?.addRange(active.range ?? range);
  document.execCommand(command, false, value);
  active.change();
  document.dispatchEvent(new Event("selectionchange"));
  if (
    focused instanceof HTMLElement &&
    focused.closest("[data-rich-text-controls]") &&
    focused.tagName === "INPUT"
  )
    focused.focus();
}

export function RichTextSelectionControls({
  selection,
  onCommand = applyTextCommand,
  onFinishEditing,
}: {
  selection: Snapshot;
  onCommand?: (command: TextCommand, value?: string) => void;
  onFinishEditing?: () => void;
}) {
  const [draft, setDraft] = useState<{ source: string; value: string } | null>(null);
  const href = draft?.source === selection.href ? draft.value : selection.href;
  const invalid = Boolean(href) && !textLinkSchema.safeParse(href).success;
  return (
    <div
      data-rich-text-controls
      className="space-y-3"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing || !onFinishEditing) return;
        event.preventDefault();
        event.stopPropagation();
        setDraft(null);
        onFinishEditing();
      }}
    >
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ["bold", "Bold"],
            ["italic", "Italic"],
            ["underline", "Underline"],
            ["strikeThrough", "Strike"],
            ["insertUnorderedList", "Bulleted list"],
            ["insertOrderedList", "Numbered list"],
          ] as const
        ).map(([command, label]) => (
          <button
            key={command}
            type="button"
            aria-pressed={selection.marks[command]}
            className="rounded-md border border-primary-grey/70 px-2 py-1.5 text-xs hover:bg-primary-grey/20"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onCommand(command)}
          >
            <span data-ph-public>{label}</span>
          </button>
        ))}
      </div>
      <label className="block text-xs">
        <span data-ph-public style={{ display: "contents" }}>
          Link URL
        </span>
        <input
          data-ph-public-label
          aria-label="Text selection link"
          aria-invalid={invalid}
          value={href}
          className="mt-1 w-full rounded-md border border-primary-grey/70 px-2 py-1.5 text-xs"
          onChange={(event) => {
            const value = event.target.value;
            setDraft({ source: selection.href, value });
            if (!value) onCommand("unlink");
            else if (textLinkSchema.safeParse(value).success) onCommand("createLink", value);
          }}
        />
      </label>
      {invalid && (
        <p data-ph-public role="status" className="text-xs">
          Use an http(s), mailto, tel, root-relative or fragment URL.
        </p>
      )}
      <button
        data-ph-public
        type="button"
        disabled={!selection.href && selection.marks.unlink === false}
        className="text-xs underline disabled:opacity-40"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          setDraft({ source: selection.href, value: "" });
          onCommand("unlink");
        }}
      >
        Remove link
      </button>
    </div>
  );
}
