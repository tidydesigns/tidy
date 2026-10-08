"use client";
import { useLayoutEffect, useRef } from "react";
import type { DesignNode } from "@bella/design/document";
import { customStroke, strokeStyle } from "./strokes";

/** Refine the shared SSR border image to the actual fill/hug size without adding layout wrappers. */
export function NodeStrokes({
  node,
  tokens,
}: {
  node: DesignNode;
  tokens: Record<string, string>;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current?.parentElement;
    if (node.vectorPath || !element || !customStroke(node.style)) return;
    const measure = () => {
      const computed = getComputedStyle(element),
        width = parseFloat(computed.width),
        height = parseFloat(computed.height);
      if (width > 0 && height > 0) {
        const style = strokeStyle(node, tokens, { width, height });
        if (element.style.borderImageSource !== style.borderImageSource)
          element.style.borderImageSource = style.borderImageSource as string;
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [node, tokens]);
  return !node.vectorPath && customStroke(node.style) ? (
    <span ref={ref} hidden aria-hidden="true" data-stroke-measure />
  ) : null;
}
