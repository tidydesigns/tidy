"use client";
import { ImageMimeProvider } from "@tidy/design-renderer/image-context";
import { booleanRenderNode, vectorCompositeStyle } from "@tidy/design-renderer/vector-composites";
import { strokeOutsets } from "@/lib/design/strokes";
import { NodeStrokes } from "@/components/design/node-strokes";
import { NodeFills } from "@/components/design/node-fills";

import { DesignText } from "@/components/design/design-text";
import { DesignImage } from "@/components/design/design-image";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DesignDocument, DesignNode } from "@/lib/design/document";
import { resolvedColorTokens, resolvedDocumentNodes } from "@/lib/design/design-tokens";
import { nodeStyle } from "@/lib/design/node-style";
import { responsiveNode } from "@/lib/design/responsive-layout";
import { useDocumentFonts } from "@/lib/design/fonts/use-document-fonts";

export function DesignSnapshot({
  reviewId,
  content,
  frameId,
  selectedNode,
  onSelect,
  assetUrl,
}: {
  reviewId: string;
  content: DesignDocument;
  frameId: string;
  selectedNode: string | null;
  onSelect: (id: string) => void;
  assetUrl?: (id: string) => string;
}) {
  const renderedNodes = useMemo(
    () =>
      resolvedDocumentNodes({
        nodes: content.nodes,
        tokens: content.tokens,
        designTokens: content.designTokens,
      }),
    [content.nodes, content.tokens, content.designTokens],
  );
  const tokens = resolvedColorTokens(content);
  const imageUrl = assetUrl ?? ((id: string) => `/api/github/reviews/${reviewId}/assets/${id}`);
  useDocumentFonts(renderedNodes);
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const frame = renderedNodes.find((node) => node.id === frameId);
  if (!frame) return null;
  const frameWidth = frame.box.width;
  const [top, right, bottom, left] = strokeOutsets(frame);
  const visualWidth = frame.box.width + left + right,
    visualHeight = frame.box.height + top + bottom;
  const scale = Math.min(1, width / visualWidth);
  const children = new Map<string, DesignNode[]>();
  for (const node of renderedNodes)
    if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  function draw(node: DesignNode, parentLayout: DesignNode["layout"] = "absolute", flowIndex = 0) {
    if (!node.visible) return null;
    const rendered = booleanRenderNode(responsiveNode(node, frameWidth), renderedNodes);
    const parent = renderedNodes.find((item) => item.id === node.parentId);
    const style = nodeStyle(
      rendered,
      parentLayout,
      tokens,
      parent ? responsiveNode(parent, frameWidth) : undefined,
      flowIndex,
    );
    Object.assign(style, vectorCompositeStyle(node, renderedNodes, tokens, parent));
    if (node.id === frameId) {
      style.left = left;
      style.top = top;
    }
    if (node.id === selectedNode)
      style.outline = `${2 / scale}px solid var(--color-primary-orange)`;
    let childFlowIndex = 0;
    return (
      <div
        key={node.id}
        style={style}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(node.id);
        }}
      >
        <NodeStrokes node={rendered} tokens={tokens} />
        <NodeFills node={rendered} tokens={tokens} assetUrl={imageUrl} />
        {node.type === "text" ? (
          <DesignText node={node} />
        ) : (node.assetId || rendered.vectorPath) &&
          (rendered.type === "image" || rendered.type === "vector") ? (
          <DesignImage tokens={tokens} node={rendered} src={imageUrl(node.assetId!)} />
        ) : null}
        {children.get(node.id)?.map((child) => {
          const index = childFlowIndex;
          if (child.visible && child.positionMode !== "absolute") childFlowIndex++;
          return draw(child, rendered.layout, index);
        })}
      </div>
    );
  }
  return (
    <ImageMimeProvider types={content.assetMimeTypes}>
      <div
        ref={container}
        className="w-full overflow-hidden rounded-md border border-primary-grey/70 bg-canvas"
        style={{ height: visualHeight * scale }}
      >
        <div
          style={{
            position: "relative",
            width: visualWidth,
            height: visualHeight,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          {draw(frame)}
        </div>
      </div>
    </ImageMimeProvider>
  );
}
