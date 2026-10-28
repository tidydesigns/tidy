import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type ComponentProps,
  type Ref,
} from "react";
import type { AttachedFile } from "../../../../shared/contracts/attachments";
import {
  attachmentParts,
  attachmentReference,
  attachmentText,
} from "../../../../shared/models/attachment-references";
import { attachmentReferenceClassName, attachmentSize } from "./message-attachments";

export type PromptEditorHandle = {
  focus(): void;
  cursor(): number;
  setSelectionRange(start: number, end: number): void;
};
type Props = Omit<ComponentProps<"div">, "ref" | "onChange" | "onInput" | "onPaste"> & {
  ref?: Ref<PromptEditorHandle>;
  value: string;
  onChange(value: string): void;
  files?: AttachedFile[];
  onAttachFiles?(files: File[]): AttachedFile[];
  onCursorChange?(cursor: number): void;
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
};

function read(node: Node): string {
  if (node instanceof HTMLElement && node.dataset.attachmentId)
    return attachmentReference({ id: node.dataset.attachmentId });
  if (node.nodeName === "BR") return node.nextSibling ? "\n" : "";
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  return Array.from(
    node.childNodes,
    (child, index) =>
      `${index && (child.nodeName === "DIV" || child.nodeName === "P") ? "\n" : ""}${read(child)}`,
  ).join("");
}

function offset(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.focusNode || !root.contains(selection.focusNode)) return read(root).length;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(selection.focusNode, selection.focusOffset);
  return read(range.cloneContents()).length;
}

function select(root: HTMLElement, start: number, end: number) {
  const range = document.createRange();
  function point(position: number): [Node, number] {
    let remaining = position;
    for (const node of root.childNodes) {
      const size = read(node).length;
      if (remaining <= size) {
        if (node.nodeType === Node.TEXT_NODE) return [node, remaining];
        return [root, Array.from(root.childNodes).indexOf(node) + (remaining > 0 ? 1 : 0)];
      }
      remaining -= size;
    }
    return [root, root.childNodes.length];
  }
  range.setStart(...point(start));
  range.setEnd(...point(end));
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

function fragment(text: string, files: AttachedFile[]) {
  const result = document.createDocumentFragment();
  for (const part of attachmentParts(text, files)) {
    if (part.kind === "text") result.append(document.createTextNode(part.text));
    else {
      const chip = document.createElement("span");
      chip.className = attachmentReferenceClassName;
      chip.contentEditable = "false";
      chip.draggable = false;
      chip.dataset.attachmentId = part.referenceId;
      chip.title = `${part.file.name} · ${attachmentSize(part.file.size)}`;
      chip.textContent = part.file.name;
      result.append(chip);
    }
  }
  return result;
}

export function PromptEditor({
  ref,
  value,
  onChange,
  files = [],
  onAttachFiles,
  onCursorChange,
  disabled,
  placeholder,
  maxLength = 32_000,
  className,
  autoFocus,
  onKeyDown,
  ...props
}: Props) {
  const input = useRef<HTMLDivElement>(null);
  const lastValue = useRef(value);
  const composing = useRef(false);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => input.current?.focus(),
      cursor: () => (input.current ? offset(input.current) : 0),
      setSelectionRange: (start, end) => {
        if (input.current) select(input.current, start, end);
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    const root = input.current;
    if (!root || composing.current) return;
    if (read(root) !== value) {
      const cursor = offset(root);
      const focused = document.activeElement === root;
      root.replaceChildren(fragment(value, files));
      if (value.endsWith("\n")) root.append(document.createElement("br"));
      if (focused) select(root, Math.min(cursor, value.length), Math.min(cursor, value.length));
    }
    root.dataset.empty = String(!value);
    lastValue.current = value;
  }, [value, files]);
  useLayoutEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  function change() {
    const root = input.current;
    if (!root || composing.current) return;
    const next = read(root);
    if (next.length > maxLength) {
      root.replaceChildren(fragment(lastValue.current, files));
      select(root, lastValue.current.length, lastValue.current.length);
      return;
    }
    const selection = window.getSelection();
    const focus = selection?.focusNode;
    const chip = (focus instanceof Element ? focus : focus?.parentElement)?.closest(
      "[data-attachment-id]",
    );
    if (selection?.isCollapsed && chip && root.contains(chip)) {
      const range = document.createRange();
      range.setStartAfter(chip);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    lastValue.current = next;
    root.dataset.empty = String(!next);
    onChange(next);
    onCursorChange?.(offset(root));
  }
  function insert(text: string, attached = files) {
    text = text.replace(/\r\n?/g, "\n");
    const root = input.current;
    if (!root) return;
    const selection = window.getSelection();
    const selected = selection?.rangeCount
      ? read(selection.getRangeAt(0).cloneContents()).length
      : 0;
    if (read(root).length - selected + text.length > maxLength) return;
    const container = document.createElement("div");
    container.append(fragment(text, attached));
    const after = document.createRange();
    after.selectNodeContents(root);
    if (selection?.rangeCount) {
      const range = selection.getRangeAt(0);
      after.setStart(range.endContainer, range.endOffset);
    }
    const trailingBreak = text.endsWith("\n") && !read(after.cloneContents()) ? "<br>" : "";
    document.execCommand(
      "insertHTML",
      false,
      container.innerHTML.replaceAll("\n", "<br>") + trailingBreak,
    );
    change();
  }
  function copy(event: ClipboardEvent<HTMLDivElement>) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return false;
    event.preventDefault();
    const text = read(selection.getRangeAt(0).cloneContents());
    event.clipboardData.setData("text/plain", attachmentText(text, files));
    event.clipboardData.setData("application/x-tidy-message", text);
    return true;
  }
  return (
    <div
      {...props}
      ref={input}
      className={`prompt-editor cursor-text whitespace-pre-wrap wrap-anywhere aria-disabled:cursor-default data-[empty=true]:before:pointer-events-none data-[empty=true]:before:text-muted-ink data-[empty=true]:before:content-[attr(data-placeholder)] ${className ?? ""}`}
      contentEditable={!disabled}
      suppressContentEditableWarning
      aria-disabled={disabled || undefined}
      aria-multiline="true"
      data-placeholder={placeholder}
      data-empty={!value}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (disabled) return;
        if ((event.metaKey || event.ctrlKey) && ["b", "i", "u"].includes(event.key.toLowerCase())) {
          event.preventDefault();
          return;
        }
        if (event.key === "Enter" && !event.defaultPrevented && !event.nativeEvent.isComposing) {
          event.preventDefault();
          insert("\n");
        }
      }}
      onInput={change}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        change();
      }}
      onSelect={() => {
        if (input.current) onCursorChange?.(offset(input.current));
      }}
      onPaste={(event) => {
        event.preventDefault();
        if (disabled) return;
        const pasted = Array.from(event.clipboardData.files);
        if (pasted.length && onAttachFiles) {
          const selected = window.getSelection();
          const selectedLength = selected?.rangeCount
            ? read(selected.getRangeAt(0).cloneContents()).length
            : 0;
          if (
            read(event.currentTarget).length -
              selectedLength +
              pasted.length * (attachmentReference({ id: "" }).length + 36) +
              pasted.length -
              1 >
            maxLength
          )
            return;
          const attached = onAttachFiles(pasted);
          if (attached.length)
            insert(attached.map(attachmentReference).join(" "), [...files, ...attached]);
        } else {
          const copied = event.clipboardData.getData("application/x-tidy-message");
          insert(
            attachmentParts(copied, files).some((part) => part.kind === "attachment")
              ? copied
              : event.clipboardData.getData("text/plain"),
          );
        }
      }}
      onCopy={copy}
      onCut={(event) => {
        if (disabled || !copy(event)) return;
        document.execCommand("delete");
        change();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) return;
        event.preventDefault();
        if (disabled) return;
        insert(event.dataTransfer.getData("text/plain"));
      }}
    />
  );
}
