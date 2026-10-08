"use client";
import { useLayoutEffect, useRef, type ClipboardEvent } from "react";
import type { DesignNode } from "@/lib/design/document";
import { richTextSchema, textParagraphs, type TextContent } from "@bella/design/rich-text";
import { renderFontFamily } from "@/lib/design/fonts/family";
import { readEditableRichText, richTextElements, sanitizeRichPaste } from "./rich-text-dom";
import { registerRichTextSelection, applyTextCommand } from "./rich-text-selection";

export function readEditableText(root: Node): string {
  return readEditableRichText(root).text;
}

/** Native selection/typing/undo stay in the browser; commit the complete editing session once. */
export function EditableDesignText({
  node,
  onFinish,
  onDraft,
}: {
  node: DesignNode;
  onDraft?: (value: TextContent) => void;
  onFinish: (value: TextContent | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    initial = useRef(
      textParagraphs({ text: node.text ?? "", richText: node.richText }).map((paragraph) => ({
        ...paragraph,
        runs: paragraph.runs.map((run) => ({
          ...run,
          underline: run.underline ?? node.style.textDecoration === "underline",
          strike: run.strike ?? node.style.textDecoration === "line-through",
        })),
      })),
    );
  const callbacks = useRef({ onDraft, onFinish });
  useLayoutEffect(() => {
    callbacks.current = { onDraft, onFinish };
  });
  const dirty = useRef(false);
  const cancelled = useRef(false),
    finished = useRef(false);
  const spacing = node.style.paragraphSpacing ?? 0,
    initialSpacing = useRef(spacing);
  const error = useRef<HTMLParagraphElement>(null);
  const initialFontFamily = useRef(
    node.style.fontFace ? renderFontFamily(node.style.fontFamily) : undefined,
  );
  function draft() {
    dirty.current = true;
    if (ref.current) callbacks.current.onDraft?.(readEditableRichText(ref.current));
  }
  function finish() {
    if (finished.current || !ref.current) return;
    const value = readEditableRichText(ref.current);
    if (!cancelled.current && !richTextSchema.safeParse(value.richText).success) {
      if (error.current)
        error.current.textContent =
          "Text supports at most 10,000 characters and 2,000 runs. Shorten the text to finish editing.";
      ref.current.focus();
      return;
    }
    finished.current = true;
    callbacks.current.onFinish(cancelled.current || !dirty.current ? null : value);
  }
  const finishRef = useRef(finish);
  useLayoutEffect(() => {
    finishRef.current = finish;
  });
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.replaceChildren(
      ...richTextElements(initial.current, initialSpacing.current, initialFontFamily.current),
    );
    root.focus();
    const range = document.createRange(),
      selection = window.getSelection();
    range.selectNodeContents(root);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const unregister = registerRichTextSelection(root, node.id, () => {
      dirty.current = true;
      callbacks.current.onDraft?.(readEditableRichText(root));
    });
    const focus = (event: FocusEvent) => {
      if (
        event.target instanceof Element &&
        !root.contains(event.target) &&
        !event.target.closest("[data-rich-text-controls]")
      )
        finishRef.current();
    };
    document.addEventListener("focusin", focus);
    return () => {
      unregister();
      document.removeEventListener("focusin", focus);
    };
  }, [node.id]);
  useLayoutEffect(() => {
    for (const [index, child] of Array.from(
      ref.current?.querySelectorAll("[data-text-paragraph], li") ?? [],
    ).entries())
      if (child instanceof HTMLElement) child.style.marginTop = index ? `${spacing}px` : "0px";
  }, [spacing]);
  function paste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const rich = event.clipboardData.getData("text/html"),
      plain = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    if (rich) document.execCommand("insertHTML", false, sanitizeRichPaste(rich, plain));
    else document.execCommand("insertText", false, plain);
    draft();
  }
  function copy(event: ClipboardEvent<HTMLDivElement>, cut = false) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0),
      holder = document.createElement("div");
    holder.appendChild(range.cloneContents());
    event.preventDefault();
    const ancestor =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    const styled = document.createElement("span"),
      computed = ancestor ? getComputedStyle(ancestor) : undefined;
    if (computed) {
      styled.style.fontWeight = computed.fontWeight;
      styled.style.fontStyle = computed.fontStyle;
      styled.style.textDecoration = computed.textDecorationLine;
    }
    const link = ancestor?.closest("a");
    const wrapper = link ? document.createElement("a") : styled;
    if (link) {
      wrapper.setAttribute("href", link.getAttribute("href") ?? "");
      wrapper.appendChild(styled);
    }
    for (const child of Array.from(holder.childNodes)) styled.appendChild(child);
    holder.appendChild(wrapper);
    const item = ancestor?.closest("li");
    if (item && ref.current?.contains(item)) {
      const list = document.createElement(item.parentElement?.tagName === "OL" ? "ol" : "ul");
      const li = document.createElement("li");
      for (const child of Array.from(holder.childNodes)) li.appendChild(child);
      list.appendChild(li);
      holder.appendChild(list);
    }
    event.clipboardData.setData("text/html", holder.innerHTML);
    event.clipboardData.setData("text/plain", readEditableRichText(holder).text);
    if (cut) {
      document.execCommand("delete");
      draft();
    }
  }
  return (
    <>
      <div
        ref={ref}
        data-design-text
        data-rich-text-editor={node.id}
        contentEditable
        role="textbox"
        aria-label={`Edit ${node.name}`}
        aria-multiline="true"
        suppressContentEditableWarning
        style={{
          display: "block",
          flex: "0 0 auto",
          minWidth: 0,
          width: "100%",
          whiteSpace: "inherit",
          overflowWrap: "break-word",
          outline: "none",
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onInput={draft}
        onPaste={paste}
        onCopy={(event) => copy(event)}
        onCut={(event) => copy(event, true)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            (event.metaKey || event.ctrlKey) &&
            ["b", "i", "u"].includes(event.key.toLowerCase())
          ) {
            event.preventDefault();
            applyTextCommand(
              event.key.toLowerCase() === "b"
                ? "bold"
                : event.key.toLowerCase() === "i"
                  ? "italic"
                  : "underline",
            );
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancelled.current = true;
            finish();
          }
        }}
        onBlur={(event) => {
          if (
            !(
              event.relatedTarget instanceof Element &&
              event.relatedTarget.closest("[data-rich-text-controls]")
            )
          )
            queueMicrotask(() => {
              if (
                !ref.current?.contains(document.activeElement) &&
                !document.activeElement?.closest("[data-rich-text-controls]")
              )
                finishRef.current();
            });
        }}
      />
      <p ref={error} role="status" className="text-xs" />
    </>
  );
}
