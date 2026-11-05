import type { Blockquote, Code, ListItem, Parent, Root, RootContent } from "mdast";
import { useCallback, useEffect, useRef, useState } from "react";

export function useBlockReveal(active: boolean) {
  const [lingering, setLingering] = useState(active);
  useEffect(() => {
    if (active) {
      setLingering(true);
      return;
    }
    if (!lingering) return;
    const timer = setTimeout(() => setLingering(false), 600);
    return () => clearTimeout(timer);
  }, [active, lingering]);
  return active || lingering;
}

export function useBufferedMarkdown(text: string, buffering: boolean) {
  const [displayed, setDisplayed] = useState(text);
  const latest = useRef(text);
  const publishedAt = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const exposed = useRef(buffering ? "" : text);
  const replaced = !text.startsWith(displayed);
  if (!buffering || replaced) exposed.current = text;
  const minimum = text.startsWith(exposed.current) ? exposed.current.length : 0;
  useEffect(() => {
    latest.current = text;
    if (!buffering || replaced) {
      clearTimeout(pending.current);
      pending.current = undefined;
      publishedAt.current = performance.now();
      setDisplayed(text);
      return;
    }
    if (pending.current !== undefined || displayed === text) return;
    pending.current = setTimeout(
      () => {
        pending.current = undefined;
        publishedAt.current = performance.now();
        setDisplayed(latest.current);
      },
      Math.max(0, 160 - (performance.now() - publishedAt.current)),
    );
  }, [text, buffering, replaced, displayed]);
  const onExpose = useCallback((offset: number) => {
    if (offset > exposed.current.length) exposed.current = latest.current.slice(0, offset);
  }, []);
  useEffect(() => () => clearTimeout(pending.current), []);
  return {
    text: !buffering || replaced || displayed.length < minimum ? text : displayed,
    minimum,
    onExpose,
  };
}

function expandTabs(line: string) {
  let padding = 0;
  return line.replace(/\t/gu, (_tab, offset: number) => {
    const spaces = 4 - ((offset + padding) % 4);
    padding += spaces - 1;
    return " ".repeat(spaces);
  });
}

function closedFence(block: Code, text: string, containers: (ListItem | Blockquote)[] = []) {
  const raw = text.slice(block.position?.start.offset ?? 0, block.position?.end.offset).trimEnd();
  const lines = raw.split(/\r?\n/u);
  const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(lines[0]);
  if (!opening || lines.length < 2) return false;
  let closing = expandTabs(lines.at(-1) ?? "");
  for (const container of containers) {
    if (container.type === "blockquote") {
      closing = closing.replace(/^ {0,3}> ?/u, "");
    } else {
      const start = container.position?.start.offset ?? 0;
      const marker = /^(?:[*+-]|\d{1,9}[.)])([ \t]*)/u.exec(text.slice(start));
      if (!marker) return false;
      const prefix = text.slice(text.lastIndexOf("\n", start - 1) + 1, start);
      const markerWidth = marker[0].length - marker[1].length;
      const gap = expandTabs(prefix + marker[0]).length - (expandTabs(prefix).length + markerWidth);
      const next = text[start + marker[0].length];
      const indent = markerWidth + (!next || next === "\n" || next === "\r" || gap > 4 ? 1 : gap);
      closing = closing.replace(new RegExp(`^ {0,${indent}}`, "u"), "");
    }
  }
  const marker = opening[1];
  return new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \t]*$`, "u").test(closing);
}

function holdUnfinishedCode(node: Parent, text: string, containers: (ListItem | Blockquote)[]) {
  const tail = node.children.at(-1);
  if (!tail) return;
  if (tail.type === "code") {
    if (!closedFence(tail, text, containers)) node.children.pop();
  } else if (tail.type === "list" || tail.type === "listItem" || tail.type === "blockquote") {
    holdUnfinishedCode(tail, text, tail.type === "list" ? containers : [...containers, tail]);
    if (!tail.children.length) node.children.pop();
  }
}

export function remarkCompleteBlocks({
  text,
  streaming,
  minimum,
  onExpose,
}: {
  text: string;
  streaming: boolean;
  minimum: number;
  onExpose?: (offset: number) => void;
}) {
  return (root: Root) => {
    const tail = root.children.at(-1);
    if (!streaming || !tail) return;
    const ready = root.children.slice(0, -1);
    const exposed = (tail.position?.start.offset ?? text.length) < minimum;
    const codeReady = tail.type === "code" && closedFence(tail, text);
    const separated = /\r?\n[ \t]*\r?\n[ \t]*$/u.test(text);
    if (tail.type === "list") {
      const items = tail.children.filter(
        (item, index) =>
          index < tail.children.length - 1 ||
          (item.position?.start.offset ?? text.length) < minimum ||
          (separated && item.children.at(-1)?.type === "paragraph"),
      );
      const last = items.at(-1);
      if (last && last === tail.children.at(-1)) {
        holdUnfinishedCode(last, text, [last]);
        if (!last.children.length) items.pop();
      }
      if (items.length) ready.push({ ...tail, children: items });
    } else if (
      exposed ||
      tail.type === "paragraph" ||
      codeReady ||
      (separated && tail.type !== "heading" && tail.type !== "code" && tail.type !== "blockquote")
    ) {
      ready.push(tail);
    }
    while (ready.at(-1)?.type === "heading") {
      if ((ready.at(-1)?.position?.start.offset ?? text.length) < minimum) break;
      ready.pop();
    }
    root.children = ready;
    let last: RootContent | undefined = ready.at(-1);
    while (last && (last.type === "list" || last.type === "listItem" || last.type === "blockquote"))
      last = last.children.at(-1);
    onExpose?.(last?.position?.end.offset ?? 0);
  };
}
