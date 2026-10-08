"use client";
import { useState, useSyncExternalStore } from "react";
import { textLinkSchema } from "@bella/design/rich-text";

type Command =
  | "bold"
  | "italic"
  | "underline"
  | "strikeThrough"
  | "insertUnorderedList"
  | "insertOrderedList"
  | "createLink"
  | "unlink";
type Snapshot = { nodeId: string; marks: Record<Command, boolean | "mixed">; href: string };
let snapshot: Snapshot | null = null;
let session: { root: HTMLElement; range?: Range; change: () => void } | null = null;
const listeners = new Set<() => void>();
const commands: Command[] = [
  "bold",
  "italic",
  "underline",
  "strikeThrough",
  "insertUnorderedList",
  "insertOrderedList",
  "createLink",
  "unlink",
];
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
  const active = { root, change, range: undefined as Range | undefined };
  session = active;
  const update = () => {
    const selection = window.getSelection();
    if (session !== active || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    active.range = range.cloneRange();
    const marks = Object.fromEntries(
      commands.map((command) => [
        command,
        document.queryCommandIndeterm(command) ? "mixed" : document.queryCommandState(command),
      ]),
    ) as Snapshot["marks"];
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

export function applyTextCommand(command: Command, value?: string) {
  if (!session?.range || (command === "createLink" && !textLinkSchema.safeParse(value).success))
    return;
  const active = session,
    selection = window.getSelection();
  const focused = document.activeElement;
  const liveRange = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  if (
    liveRange &&
    active.root.contains(liveRange.startContainer) &&
    active.root.contains(liveRange.endContainer)
  )
    active.range = liveRange.cloneRange();
  active.root.focus();
  selection?.removeAllRanges();
  selection?.addRange(active.range!);
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

export function RichTextSelectionControls({ selection }: { selection: Snapshot }) {
  const [href, setHref] = useState(selection.href);
  const invalid = Boolean(href) && !textLinkSchema.safeParse(href).success;
  return (
    <div data-rich-text-controls className="space-y-3">
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
            onClick={() => applyTextCommand(command)}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="block text-xs">
        Link URL
        <input
          aria-label="Text selection link"
          aria-invalid={invalid}
          value={href}
          className="mt-1 w-full rounded-md border border-primary-grey/70 px-2 py-1.5 text-xs"
          onChange={(event) => {
            const value = event.target.value;
            setHref(value);
            if (!value) applyTextCommand("unlink");
            else if (textLinkSchema.safeParse(value).success) applyTextCommand("createLink", value);
          }}
        />
      </label>
      {invalid && (
        <p role="status" className="text-xs">
          Use an http(s), mailto, tel, root-relative or fragment URL.
        </p>
      )}
      {selection.href && (
        <button
          type="button"
          className="text-xs underline"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            setHref("");
            applyTextCommand("unlink");
          }}
        >
          Remove link
        </button>
      )}
    </div>
  );
}
