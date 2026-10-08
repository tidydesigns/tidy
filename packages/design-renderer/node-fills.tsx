"use client";
import { useLayoutEffect, useRef, useState } from "react";
import type { DesignNode } from "@bella/design/document";
import { paintBackground } from "./paints";
import { DesignImage } from "./design-image";
export function NodeFills({
  node,
  tokens,
  assetUrl = (id) => `/api/assets/${id}`,
}: {
  node: DesignNode;
  tokens: Record<string, string>;
  assetUrl?: (id: string) => string;
}) {
  if (node.vectorPath || !node.style.paints?.length) return null;
  const solePaint = node.style.paints.length === 1 ? node.style.paints[0] : undefined;
  if (
    solePaint?.visible &&
    solePaint.opacity === 1 &&
    (!solePaint.blendMode || solePaint.blendMode === "normal") &&
    solePaint.type !== "image" &&
    !(solePaint.type === "linear" && solePaint.start) &&
    !(solePaint.type === "radial" && solePaint.rotation)
  )
    return null;
  return <MeasuredFills node={node} tokens={tokens} assetUrl={assetUrl} />;
}
function MeasuredFills({
  node,
  tokens,
  assetUrl,
}: {
  node: DesignNode;
  tokens: Record<string, string>;
  assetUrl: (id: string) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: node.box.width, height: node.box.height });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element),
        width = parseFloat(style.width),
        height = parseFloat(style.height);
      if (width > 0 && height > 0)
        setSize((previous) =>
          previous.width === width && previous.height === height ? previous : { width, height },
        );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-fill-stack
      style={{
        position: "absolute",
        inset: 0,
        zIndex: -1,
        pointerEvents: "none",
        borderRadius: "inherit",
        ...({ cornerShape: "inherit" } as React.CSSProperties),
        overflow: "hidden",
      }}
    >
      {[...(node.style.paints ?? [])]
        .reverse()
        .filter((paint) => paint.visible)
        .map((paint) => (
          <div
            key={paint.id}
            data-fill-id={paint.id}
            style={{
              position: "absolute",
              inset: 0,
              opacity: paint.opacity,
              mixBlendMode: paint.blendMode,
              background: paintBackground(paint, tokens, size),
            }}
          >
            {paint.type === "image" && paint.assetId && (
              <DesignImage
                node={{
                  ...node,
                  name: "",
                  assetId: paint.assetId,
                  style: {
                    objectFit: paint.fit,
                    objectPositionX: paint.positionX,
                    objectPositionY: paint.positionY,
                    imageCrop: paint.crop,
                  },
                }}
                src={assetUrl(paint.assetId)}
              />
            )}
          </div>
        ))}
    </div>
  );
}
