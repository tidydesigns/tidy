import type { Code, Root } from "mdast";
import { useEffect, useRef, useState } from "react";

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
      Math.max(0, 400 - (performance.now() - publishedAt.current)),
    );
  }, [text, buffering, replaced, displayed]);
  useEffect(() => () => clearTimeout(pending.current), []);
  return {
    text: !buffering || replaced || displayed.length < minimum ? text : displayed,
    minimum,
  };
}

function closedFence(block: Code, text: string) {
  const raw = text.slice(block.position?.start.offset ?? 0, block.position?.end.offset).trimEnd();
  const lines = raw.split(/\r?\n/u);
  const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(lines[0]);
  if (!opening || lines.length < 2) return false;
  const marker = opening[1];
  return new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`, "u").test(lines.at(-1) ?? "");
}

export function remarkCompleteBlocks({
  text,
  streaming,
  minimum,
}: {
  text: string;
  streaming: boolean;
  minimum: number;
}) {
  return (root: Root) => {
    const tail = root.children.at(-1);
    if (!streaming || !tail) return;
    const ready = root.children.slice(0, -1);
    const exposed = (tail.position?.start.offset ?? text.length) < minimum;
    const codeReady = tail.type === "code" && closedFence(tail, text);
    const separated = /\r?\n[ \t]*\r?\n[ \t]*$/u.test(text);
    if (exposed) {
      ready.push(tail);
    } else if (tail.type === "list") {
      const items = tail.children.filter(
        (item, index) =>
          index < tail.children.length - 1 ||
          (separated && item.children.at(-1)?.type === "paragraph"),
      );
      if (items.length) ready.push({ ...tail, children: items });
    } else if (
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
  };
}
