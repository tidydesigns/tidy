import {
  readMessageClipboard,
  messageClipboardContent,
  MESSAGE_CLIPBOARD_MIME,
  type ClipboardMessage,
} from "../threads/message-clipboard";
import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type ComponentProps,
  type Ref,
} from "react";
import { type AttachedFile } from "../../../../shared/contracts/attachments";
import { showToast } from "@tidy/ui/toast";
import {
  attachmentParts,
  attachmentReference,
  attachmentText,
  remapAttachmentReferences,
} from "../../../../shared/models/attachment-references";
import { attachmentReferenceClassName, attachmentSize } from "./message-attachments";
import { skillCommands, type Skill } from "../../../../shared/contracts/skills";
import "./prompt-editor.css";

export type PromptEditorHandle = {
  focus(): void;
  cursor(): number;
  atBoundary(direction: "up" | "down"): boolean;
  setSelectionRange(start: number, end: number): void;
  insertAttachments(files: AttachedFile[], point?: { x: number; y: number }): void;
  insertText(text: string): void;
};
type Props = Omit<ComponentProps<"div">, "ref" | "onChange" | "onInput" | "onPaste"> & {
  ref?: Ref<PromptEditorHandle>;
  value: string;
  onChange(value: string): void;
  files?: AttachedFile[];
  onAttachFiles?(files: File[]): AttachedFile[];
  onPasteMessage?(message: ClipboardMessage): AttachedFile[];
  clipboardSource?: { projectId: string; machineId: string };
  attachmentsReady?: boolean;
  onCursorChange?(cursor: number): void;
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
  skill?: Pick<Skill, "name">;
  skills?: readonly Pick<Skill, "name">[];
};

function read(node: Node): string {
  if (node instanceof HTMLElement && node.dataset.attachmentId)
    return attachmentReference({ id: node.dataset.attachmentId });
  if (node instanceof HTMLElement && node.dataset.skillCommand) return node.dataset.skillCommand;
  if (node.nodeName === "BR") return node.nextSibling ? "\n" : "";
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  return Array.from(
    node.childNodes,
    (child, index) =>
      `${index && (child.nodeName === "DIV" || child.nodeName === "P") ? "\n" : ""}${read(child)}`,
  ).join("");
}

function offset(root: HTMLElement, boundary?: { node: Node; offset: number }) {
  const selection = window.getSelection();
  const focusedNode = boundary?.node ?? selection?.focusNode;
  if (!focusedNode || !root.contains(focusedNode)) return read(root).length;
  const focus = focusedNode;
  const focusOffset = boundary?.offset ?? selection?.focusOffset ?? 0;
  function position(node: Node): number {
    if (node === focus && node.nodeType === Node.TEXT_NODE) return focusOffset;
    let length = 0;
    for (const [index, child] of Array.from(node.childNodes).entries()) {
      if (node === focus && index === focusOffset) return length;
      if (index && (child.nodeName === "DIV" || child.nodeName === "P")) length += 1;
      if (child === focus || child.contains(focus)) return length + position(child);
      length += read(child).length;
    }
    return length;
  }
  return position(root);
}

function select(root: HTMLElement, start: number, end: number) {
  function point(parent: Node, position: number): [Node, number] {
    let remaining = position;
    for (const [index, node] of Array.from(parent.childNodes).entries()) {
      if (index && (node.nodeName === "DIV" || node.nodeName === "P")) {
        if (!remaining) return [parent, index];
        remaining -= 1;
      }
      const size = read(node).length;
      if (remaining <= size) {
        if (node.nodeType === Node.TEXT_NODE) return [node, remaining];
        if (
          node.nodeName === "BR" ||
          (node instanceof HTMLElement && (node.dataset.attachmentId || node.dataset.skillCommand))
        )
          return [parent, index + (remaining > 0 ? 1 : 0)];
        return point(node, remaining);
      }
      remaining -= size;
    }
    return [parent, parent.childNodes.length];
  }
  window.getSelection()?.setBaseAndExtent(...point(root, start), ...point(root, end));
}

// Paint Markdown dividers without changing editable nodes or native undo history.
const dividerRanges = new Map<HTMLElement, Range[]>();
function updateDividerHighlights() {
  if (typeof Highlight !== "undefined")
    CSS.highlights.set(
      "tidy-prompt-divider",
      new Highlight(...Array.from(dividerRanges.values()).flat()),
    );
}
function dividers(root: HTMLElement) {
  if (typeof Highlight === "undefined") return;
  const matches = Array.from(read(root).matchAll(/^---$/gm));
  if (!matches.length && !dividerRanges.get(root)?.length) return;
  // Walk text nodes once, even for drafts containing thousands of dividers.
  const segments: { node: Node; start: number; end: number }[] = [];
  let position = 0;
  function visit(node: Node) {
    if (node instanceof HTMLElement && (node.dataset.attachmentId || node.dataset.skillCommand)) {
      position += read(node).length;
    } else if (node.nodeName === "BR") {
      if (node.nextSibling) position++;
    } else if (node.nodeType === Node.TEXT_NODE) {
      const end = position + (node.textContent?.length ?? 0);
      if (end > position) segments.push({ node, start: position, end });
      position = end;
    } else {
      Array.from(node.childNodes).forEach((child, index) => {
        if (index && (child.nodeName === "DIV" || child.nodeName === "P")) position++;
        visit(child);
      });
    }
  }
  if (matches.length) visit(root);
  let segment = 0;
  function textPoint(index: number): [Node, number] {
    while (segments[segment]!.end < index) segment++;
    const part = segments[segment]!;
    return [part.node, index - part.start];
  }
  const ranges = matches.map((match) => {
    const range = document.createRange();
    range.setStart(...textPoint(match.index));
    range.setEnd(...textPoint(match.index + 3));
    return range;
  });
  dividerRanges.set(root, ranges);
  updateDividerHighlights();
  root.style.removeProperty("--prompt-divider-lines");
  root.style.removeProperty("--prompt-divider-positions");
  if (!ranges.length) return;
  const bounds = root.getBoundingClientRect();
  const padding = parseFloat(getComputedStyle(root).paddingTop) || 0;
  root.style.setProperty(
    "--prompt-divider-lines",
    ranges.map(() => "linear-gradient(var(--color-border), var(--color-border))").join(","),
  );
  root.style.setProperty(
    "--prompt-divider-positions",
    ranges
      .map((range) => {
        const rect = range.getBoundingClientRect();
        return `center ${rect.top - bounds.top - root.clientTop + root.scrollTop - padding + rect.height / 2}px`;
      })
      .join(","),
  );
}

function revealCaret(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.isCollapsed || !selection.rangeCount || !root.contains(selection.focusNode))
    return;
  const range = selection.getRangeAt(0);
  let caret = range.getBoundingClientRect();
  if (!caret.height) {
    const node = range.startContainer.childNodes[range.startOffset];
    if (node instanceof HTMLElement) caret = node.getBoundingClientRect();
  }
  if (!caret.height) return;
  const bounds = root.getBoundingClientRect();
  const padding = parseFloat(getComputedStyle(root).paddingBlockEnd) || 0;
  const bottom = bounds.top + root.clientTop + root.clientHeight - padding;
  if (caret.bottom > bottom) root.scrollTop += caret.bottom - bottom;
  else if (caret.top < bounds.top + root.clientTop + padding)
    root.scrollTop -= bounds.top + root.clientTop + padding - caret.top;
}

function attachmentFragment(text: string, files: AttachedFile[]) {
  const result = document.createDocumentFragment();
  for (const part of attachmentParts(text, files)) {
    if (part.kind === "text") result.append(document.createTextNode(part.text));
    else {
      const chip = document.createElement("span");
      chip.className = attachmentReferenceClassName;
      chip.contentEditable = "false";
      chip.draggable = false;
      chip.dataset.attachmentId = part.referenceId;
      chip.dataset.promptToken = "attachment";
      chip.title = `${part.file.name} · ${attachmentSize(part.file.size)}`;
      chip.textContent = part.file.name;
      result.append(chip);
    }
  }
  return result;
}

function renderSkillName(node: Element, name: string, expanded = false) {
  if (name.length <= 32 || expanded) {
    node.textContent = name;
    return;
  }
  const prefix = document.createElement("span");
  prefix.className = "min-w-0 overflow-hidden text-ellipsis";
  prefix.textContent = name.slice(0, -14);
  const suffix = document.createElement("span");
  suffix.className = "flex-none";
  suffix.textContent = name.slice(-14);
  node.replaceChildren(prefix, suffix);
}

function fragment(text: string, files: AttachedFile[], skills: readonly Pick<Skill, "name">[]) {
  const names = new Set(skills.map((skill) => skill.name));
  const commands = skillCommands(text).filter((command) => names.has(command.name));
  if (!commands.length) return attachmentFragment(text, files);
  const result = document.createDocumentFragment();
  let previous = 0;
  for (const command of commands) {
    result.append(attachmentFragment(text.slice(previous, command.start), files));
    const token = text.slice(command.start, command.end);
    const chip = document.createElement("span");
    chip.className =
      "skill-reference inline-flex max-w-[min(32ch,100%)] items-center gap-1 overflow-hidden rounded-[5px] border border-border bg-hover-surface px-[5px] align-[-0.2em] text-[0.92em] leading-[1.45] whitespace-nowrap text-ink aria-expanded:max-w-full aria-expanded:wrap-anywhere aria-expanded:whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-muted-ink not-forced-colors:bg-[light-dark(#f3f0fa,#2c2837)]";
    chip.contentEditable = "false";
    chip.draggable = false;
    chip.dataset.promptToken = "skill";
    chip.dataset.skillCommand = token;
    chip.title = `Skill: ${command.name}`;
    chip.setAttribute("aria-label", `Skill: ${command.name}`);
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("fill", "none");
    icon.setAttribute(
      "class",
      "size-[1em] flex-none text-muted-ink not-forced-colors:text-[light-dark(#7c65ad,#b7a1df)]",
    );
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M8 3.5C6 2.5 4 2.5 2 3v9c2-.5 4-.5 6 .5 2-1 4-1 6-.5V3c-2-.5-4-.5-6 .5Zm0 0v9",
    );
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.2");
    path.setAttribute("stroke-linejoin", "round");
    icon.append(path);
    const name = document.createElement("span");
    name.className =
      "skill-reference-name inline-flex min-w-0 overflow-hidden [direction:ltr] [unicode-bidi:isolate]";
    renderSkillName(name, command.name);
    if (command.name.length > 32) {
      chip.classList.add("cursor-pointer");
      chip.tabIndex = 0;
      chip.setAttribute("role", "button");
      chip.setAttribute("aria-expanded", "false");
    }
    chip.append(icon, name);
    result.append(chip);
    previous = command.end;
  }
  result.append(attachmentFragment(text.slice(previous), files));
  return result;
}

function toggleSkill(node: HTMLElement) {
  const name = node.querySelector(".skill-reference-name");
  const full = node.dataset.skillCommand?.slice(1);
  if (!name || !full || !node.hasAttribute("aria-expanded")) return;
  const expanded = node.getAttribute("aria-expanded") !== "true";
  node.setAttribute("aria-expanded", String(expanded));
  renderSkillName(name, full, expanded);
}

export function PromptEditor({
  ref,
  value,
  onChange,
  files = [],
  onAttachFiles,
  onPasteMessage,
  clipboardSource,
  attachmentsReady = true,
  onCursorChange,
  disabled,
  placeholder,
  maxLength = 32_000,
  skill,
  skills = skill ? [skill] : [],
  className,
  autoFocus,
  onKeyDown,
  ...props
}: Props) {
  const input = useRef<HTMLDivElement>(null);
  const lastValue = useRef(value);
  const composing = useRef(false);
  const lastCursor = useRef(0);
  type Edit = { text: string; anchor: number; focus: number };
  const undo = useRef<Edit[]>([]);
  const redo = useRef<Edit[]>([]);
  const typing = useRef<{ cursor: number; time: number } | null>(null);
  const beforeEdit = useRef<Edit | null>(null);
  function snapshot(text = lastValue.current): Edit {
    const root = input.current;
    const selected = window.getSelection();
    return {
      text,
      anchor:
        root && selected?.anchorNode
          ? offset(root, { node: selected.anchorNode, offset: selected.anchorOffset })
          : lastCursor.current,
      focus: root ? offset(root) : lastCursor.current,
    };
  }
  function restore(backward: boolean) {
    const root = input.current;
    if (!root || disabled) return;
    const source = backward ? undo.current : redo.current;
    const destination = backward ? redo.current : undo.current;
    const edit = source.pop();
    if (!edit) return;
    destination.push(snapshot());
    root.replaceChildren(fragment(edit.text, files, skills));
    if (edit.text.endsWith("\n")) root.append(document.createElement("br"));
    root.focus();
    select(root, edit.anchor, edit.focus);
    lastValue.current = edit.text;
    lastCursor.current = edit.focus;
    typing.current = null;
    beforeEdit.current = null;
    root.dataset.empty = String(!edit.text);
    dividers(root);
    onChange(edit.text);
    onCursorChange?.(edit.focus);
  }
  useImperativeHandle(
    ref,
    () => ({
      focus: () => input.current?.focus(),
      cursor: () => (input.current ? offset(input.current) : 0),
      atBoundary: (direction) => {
        const root = input.current;
        const selection = window.getSelection();
        if (!root || !selection?.isCollapsed || !selection.rangeCount) return false;
        const caret = selection.getRangeAt(0);
        if (!root.contains(caret.startContainer)) return false;
        if (!read(root)) return true;
        const contents = document.createRange();
        contents.selectNodeContents(root);
        const lines = Array.from(contents.getClientRects());
        const position = caret.getClientRects()[0];
        if (!position || !lines.length) {
          const cursor = offset(root);
          return direction === "up" ? cursor === 0 : cursor === read(root).length;
        }
        return direction === "up"
          ? position.top < Math.min(...lines.map((line) => line.bottom))
          : position.bottom > Math.max(...lines.map((line) => line.top));
      },
      setSelectionRange: (start, end) => {
        typing.current = null;
        if (input.current) select(input.current, start, end);
      },
      insertText: (text) => insert(text),
      insertAttachments: (attached, point) => {
        const root = input.current;
        if (!root || !attached.length) return;
        const cursor = Math.min(lastCursor.current, read(root).length);
        root.focus();
        const caret = point ? document.caretPositionFromPoint?.(point.x, point.y) : null;
        if (caret && root.contains(caret.offsetNode)) {
          const range = document.createRange();
          range.setStart(caret.offsetNode, caret.offset);
          range.collapse(true);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
        } else {
          select(root, cursor, cursor);
        }
        insert(attached.map(attachmentReference).join(" "), [...files, ...attached]);
      },
    }),
    [files, maxLength, onChange, onCursorChange, skills],
  );
  useLayoutEffect(() => {
    const root = input.current;
    if (!root || composing.current) return;
    const names = new Set(skills.map((skill) => skill.name));
    const expected = skillCommands(value)
      .filter((command) => names.has(command.name))
      .map((command) => value.slice(command.start, command.end));
    const rendered = Array.from(
      root.querySelectorAll<HTMLElement>("[data-skill-command]"),
      (node) => node.dataset.skillCommand,
    );
    if (value !== lastValue.current) {
      undo.current = [];
      redo.current = [];
      typing.current = null;
    }
    if (read(root) !== value || JSON.stringify(rendered) !== JSON.stringify(expected)) {
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const start =
        range && selection?.anchorNode
          ? offset(root, { node: selection.anchorNode, offset: selection.anchorOffset })
          : value.length;
      const end =
        range && selection?.focusNode
          ? offset(root, { node: selection.focusNode, offset: selection.focusOffset })
          : start;
      const focused = document.activeElement === root;
      root.replaceChildren(fragment(value, files, skills));
      if (value.endsWith("\n")) root.append(document.createElement("br"));
      if (focused) select(root, Math.min(start, value.length), Math.min(end, value.length));
    }
    dividers(root);
    for (const chip of root.querySelectorAll<HTMLElement>(".skill-reference[aria-expanded]")) {
      chip.tabIndex = disabled ? -1 : 0;
      chip.setAttribute("aria-disabled", String(Boolean(disabled)));
    }
    root.dataset.empty = String(!value);
    lastValue.current = value;
  }, [value, files, skills, disabled]);
  useLayoutEffect(() => {
    const root = input.current;
    if (!root) return;
    const observer = new ResizeObserver(() => dividers(root));
    observer.observe(root);
    return () => {
      observer.disconnect();
      dividerRanges.delete(root);
      updateDividerHighlights();
    };
  }, []);
  useLayoutEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  useLayoutEffect(() => {
    const root = input.current;
    if (!root) return;
    const before = (event: InputEvent) => {
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        restore(event.inputType === "historyUndo");
      } else if (!beforeEdit.current) beforeEdit.current = snapshot();
    };
    root.addEventListener("beforeinput", before);
    return () => root.removeEventListener("beforeinput", before);
  });

  function change(inputType = "") {
    const root = input.current;
    if (!root || composing.current) return;
    const next = read(root);
    if (next.length > maxLength) {
      root.replaceChildren(fragment(lastValue.current, files, skills));
      select(root, lastValue.current.length, lastValue.current.length);
      return;
    }
    const selection = window.getSelection();
    const focus = selection?.focusNode;
    const chip = (focus instanceof Element ? focus : focus?.parentElement)?.closest(
      "[data-prompt-token]",
    );
    if (selection?.isCollapsed && chip && root.contains(chip)) {
      const range = document.createRange();
      range.setStartAfter(chip);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (next !== lastValue.current) {
      const cursor = offset(root);
      const contiguous =
        inputType === "insertText" &&
        (!beforeEdit.current || beforeEdit.current.anchor === beforeEdit.current.focus) &&
        typing.current &&
        performance.now() - typing.current.time < 1000 &&
        cursor === typing.current.cursor + next.length - lastValue.current.length;
      if (!contiguous)
        undo.current.push(
          beforeEdit.current ?? {
            text: lastValue.current,
            anchor: lastCursor.current,
            focus: lastCursor.current,
          },
        );
      while (
        undo.current.length > 100 ||
        undo.current.reduce((sum, edit) => sum + edit.text.length, 0) > 320_000
      )
        undo.current.shift();
      redo.current = [];
      typing.current = inputType === "insertText" ? { cursor, time: performance.now() } : null;
    }
    beforeEdit.current = null;
    lastValue.current = next;
    dividers(root);
    root.dataset.empty = String(!next);
    onChange(next);
    lastCursor.current = offset(root);
    onCursorChange?.(offset(root));
  }
  function insert(text: string, attached = files) {
    text = text.replace(/\r\n?/g, "\n");
    const root = input.current;
    if (!root) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const current = read(root);
    const start = range
      ? offset(root, { node: range.startContainer, offset: range.startOffset })
      : current.length;
    const end = range
      ? offset(root, { node: range.endContainer, offset: range.endOffset })
      : current.length;
    const next = current.slice(0, start) + text + current.slice(end);
    if (next.length > maxLength) {
      showToast(`Keep messages under ${maxLength.toLocaleString()} characters.`);
      return;
    }
    beforeEdit.current = snapshot(current);
    const container = document.createElement("div");
    container.append(fragment(next, attached, skills));
    const replacement = document.createRange();
    replacement.selectNodeContents(root);
    selection?.removeAllRanges();
    selection?.addRange(replacement);
    document.execCommand(
      "insertHTML",
      false,
      container.innerHTML.replaceAll("\n", "<br>") + (next.endsWith("\n") ? "<br>" : ""),
    );
    select(root, start + text.length, start + text.length);
    change();
    revealCaret(root);
  }
  function copy(event: ClipboardEvent<HTMLDivElement>) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return false;
    event.preventDefault();
    const text = read(selection.getRangeAt(0).cloneContents());
    const selectedIds = new Set(
      attachmentParts(text, files).flatMap((part) =>
        part.kind === "attachment" ? [part.file.id] : [],
      ),
    );
    const attachments = text === value ? files : files.filter((file) => selectedIds.has(file.id));
    if (attachments.length && (!attachmentsReady || attachments.some((file) => file.importState))) {
      showToast("Wait for attachments to load, or remove failed attachments, before copying.");
      return false;
    }
    if (clipboardSource && attachments.length) {
      try {
        const content = messageClipboardContent({
          message: { text, attachments },
          ...clipboardSource,
        });
        event.clipboardData.setData("text/plain", content.text);
        event.clipboardData.setData("text/html", content.html);
        event.clipboardData.setData(MESSAGE_CLIPBOARD_MIME, content.encoded);
        return true;
      } catch {
        showToast("Could not copy these attachments. Please try again.");
        return false;
      }
    }
    event.clipboardData.setData("text/plain", attachmentText(text, files));
    event.clipboardData.setData("application/x-tidy-message", text);
    return true;
  }
  return (
    <div
      {...props}
      ref={input}
      className={`prompt-editor relative cursor-text whitespace-pre-wrap wrap-anywhere aria-disabled:cursor-default data-[empty=true]:before:pointer-events-none data-[empty=true]:before:absolute data-[empty=true]:before:text-muted-ink data-[empty=true]:before:content-[attr(data-placeholder)] ${className ?? ""}`}
      contentEditable={!disabled}
      suppressContentEditableWarning
      aria-disabled={disabled || undefined}
      aria-multiline="true"
      data-placeholder={placeholder}
      data-empty={!value}
      tabIndex={disabled ? -1 : 0}
      onClick={(event) => {
        props.onClick?.(event);
        if (disabled || event.defaultPrevented) return;
        const chip =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>(".skill-reference[aria-expanded]")
            : null;
        if (chip) toggleSkill(chip);
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        const chip =
          event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>(".skill-reference[aria-expanded]")
            : null;
        if (chip && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          toggleSkill(chip);
          return;
        }
        if (chip && event.key === "Escape" && chip.getAttribute("aria-expanded") === "true") {
          event.preventDefault();
          toggleSkill(chip);
          return;
        }
        if (
          !event.nativeEvent.isComposing &&
          !event.altKey &&
          (event.metaKey || event.ctrlKey) &&
          (event.key.toLowerCase() === "z" || (!event.metaKey && event.key.toLowerCase() === "y"))
        ) {
          event.preventDefault();
          restore(event.key.toLowerCase() === "z" && !event.shiftKey);
          return;
        }
        onKeyDown?.(event);
        if (disabled || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if ((event.metaKey || event.ctrlKey) && ["b", "i", "u"].includes(event.key.toLowerCase())) {
          event.preventDefault();
          return;
        }
        if (
          event.key === "-" &&
          !event.defaultPrevented &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.nativeEvent.isComposing &&
          window.getSelection()?.isCollapsed
        ) {
          const root = event.currentTarget;
          const text = read(root);
          const cursor = offset(root);
          const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
          if (
            text.slice(lineStart, cursor) === "--" &&
            (cursor === text.length || text[cursor] === "\n")
          ) {
            event.preventDefault();
            insert("-\n");
            return;
          }
        }
        if (event.key === "Enter" && !event.defaultPrevented && !event.nativeEvent.isComposing) {
          event.preventDefault();
          insert("\n");
        }
      }}
      onInput={(event) =>
        change(event.nativeEvent instanceof InputEvent ? event.nativeEvent.inputType : "")
      }
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        change();
      }}
      onSelect={() => {
        if (input.current) {
          lastCursor.current = offset(input.current);
          if (!window.getSelection()?.isCollapsed || typing.current?.cursor !== lastCursor.current)
            typing.current = null;
          onCursorChange?.(lastCursor.current);
        }
      }}
      onPaste={(event) => {
        event.preventDefault();
        if (disabled) return;
        const message = onPasteMessage ? readMessageClipboard(event.clipboardData) : null;
        if (message) {
          const selected = window.getSelection();
          const selectedLength = selected?.rangeCount
            ? read(selected.getRangeAt(0).cloneContents()).length
            : 0;
          if (read(event.currentTarget).length - selectedLength + message.text.length > maxLength) {
            showToast(`Keep messages under ${maxLength.toLocaleString()} characters.`);
            return;
          }
          const attached = onPasteMessage?.(message) ?? [];
          if (attached.length !== message.attachments.length) return;
          const text = remapAttachmentReferences({
            text: message.text,
            source: message.attachments,
            target: attached,
          });
          insert(text, [...files, ...attached]);
          return;
        }
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
