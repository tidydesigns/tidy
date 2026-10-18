"use client";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ImageMimeProvider } from "@tidy/design-renderer/image-context";
import { booleanRenderNode, vectorCompositeStyle } from "@tidy/design-renderer/vector-composites";
import { strokeOutsets } from "@tidy/design-renderer/strokes";
import { NodeStrokes } from "@tidy/design-renderer/node-strokes";
import { NodeFills } from "@tidy/design-renderer/node-fills";
import { DesignText } from "@tidy/design-renderer/design-text";
import { DesignImage } from "@tidy/design-renderer/design-image";
import { nodeStyle } from "@tidy/design-renderer/node-style";
import { responsiveNode } from "@tidy/design-renderer/responsive-layout";
import type { DesignDocument, DesignNode } from "@tidy/design/document";
import { childrenByParent } from "@tidy/design/node-hierarchy";
import { documentPages, pageNodes } from "../../design/pages";
import { resolvedColorTokens, resolvedDocumentNodes } from "@tidy/design/design-tokens";
import { useDocumentFonts } from "../../design/fonts/use-document-fonts";
const hostedAssetUrl = (id: string) => `/api/assets/${id}`;
type Box = { x: number; y: number; width: number; height: number };
function bounds(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function DocumentPreview({
  content,
  assetUrl = hostedAssetUrl,
}: {
  content: DesignDocument;
  assetUrl?: (id: string) => string;
}) {
  const element = useRef<SVGSVGElement>(null);
  const [measured, setMeasured] = useState<Map<string, { width: number; height: number }>>(
    () => new Map(),
  );
  const renderedContent = useMemo(
    () => ({
      ...content,
      nodes: resolvedDocumentNodes(content),
    }),
    [content],
  );
  const colors = useMemo(() => resolvedColorTokens(content), [content]);
  const page = useMemo(
    () => pageNodes(renderedContent, documentPages(renderedContent)[0].id),
    [renderedContent],
  );
  useDocumentFonts(page);
  useLayoutEffect(() => {
    const automatic = new Set(
      page
        .filter(
          (node) =>
            node.widthMode === "hug" ||
            node.heightMode === "hug" ||
            node.responsiveBreakpoints?.some(
              (point) => point.widthMode === "hug" || point.heightMode === "hug",
            ),
        )
        .map((node) => node.id),
    );
    const layers = [
      ...(element.current?.querySelectorAll<HTMLElement>("[data-thumbnail-node]") ?? []),
    ].filter((layer) => automatic.has(layer.dataset.thumbnailNode!));
    const measure = () => {
      const next = new Map(
        layers
          .map((layer) => {
            const style = getComputedStyle(layer);
            return [
              layer.dataset.thumbnailNode!,
              { width: parseFloat(style.width), height: parseFloat(style.height) },
            ] as const;
          })
          .filter(([, size]) => Number.isFinite(size.width) && Number.isFinite(size.height)),
      );
      setMeasured((previous) =>
        previous.size === next.size &&
        [...next].every(
          ([id, size]) =>
            previous.get(id)?.width === size.width && previous.get(id)?.height === size.height,
        )
          ? previous
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    layers.forEach((layer) => observer.observe(layer));
    return () => observer.disconnect();
  }, [page]);
  const preview = useMemo(() => {
    const nodes = page;
    const roots = nodes.filter((node) => node.parentId === null && node.visible);
    if (!roots.length) return null;
    const children = childrenByParent(nodes);
    const visibleBoxes: Box[] = [];
    function collect(node: DesignNode, x: number, y: number) {
      if (!node.visible) return;
      const size = measured.get(node.id) ?? node.box;
      const absolute = {
        x: x + node.box.x,
        y: y + node.box.y,
        width: size.width,
        height: size.height,
      };
      const [top, right, bottom, left] = strokeOutsets(node);
      visibleBoxes.push({
        x: absolute.x - left,
        y: absolute.y - top,
        width: absolute.width + left + right,
        height: absolute.height + top + bottom,
      });
      // Clipped descendants cannot enlarge the visible thumbnail area.
      if (
        node.style.overflow === "hidden" ||
        node.style.overflow === "auto" ||
        (node.style.overflow === undefined && ["artboard", "image"].includes(node.type))
      )
        return;
      for (const child of children.get(node.id) ?? []) collect(child, absolute.x, absolute.y);
    }
    for (const root of roots) collect(root, 0, 0);
    const area = bounds(visibleBoxes);
    const margin = Math.max(24, Math.min(area.width, area.height) * 0.08);
    return {
      roots,
      children,
      byId: new Map(nodes.map((node) => [node.id, node])),
      crop: {
        x: area.x - margin,
        y: area.y - margin,
        width: Math.max(1, area.width + margin * 2),
        height: Math.max(1, area.height + margin * 2),
      },
    };
  }, [page, measured]);
  if (!preview) return null;
  const { roots, children, crop } = preview;

  function draw(
    node: DesignNode,
    parentLayout: DesignNode["layout"] = "absolute",
    flowIndex = 0,
    frameWidth = node.box.width,
  ): React.ReactNode {
    if (!node.visible) return null;
    const viewportWidth = node.type === "artboard" ? node.box.width : frameWidth;
    const rendered = booleanRenderNode(responsiveNode(node, viewportWidth), renderedContent.nodes);
    const parent = preview!.byId.get(node.parentId ?? "");
    const style = nodeStyle(
      rendered,
      parentLayout,
      colors,
      parent ? responsiveNode(parent, viewportWidth) : undefined,
      flowIndex,
    );
    Object.assign(
      style,
      vectorCompositeStyle(node, renderedContent.nodes, colors, parent, assetUrl),
    );
    if (node.parentId === null) {
      style.left = node.box.x - crop.x;
      style.top = node.box.y - crop.y;
    }
    let childFlowIndex = 0;
    return (
      <div key={node.id} data-thumbnail-node={node.id} style={style}>
        <NodeStrokes node={rendered} tokens={colors} />
        <NodeFills node={rendered} tokens={colors} assetUrl={assetUrl} />
        {node.type === "text" ? (
          <DesignText node={node} />
        ) : (rendered.type === "image" || rendered.type === "vector") &&
          (node.assetId || rendered.vectorPath) ? (
          <DesignImage
            tokens={colors}
            node={rendered}
            src={node.assetId ? assetUrl(node.assetId) : ""}
          />
        ) : null}
        {children.get(node.id)?.map((child) => {
          const index = childFlowIndex;
          if (child.visible && child.positionMode !== "absolute") childFlowIndex++;
          return draw(child, rendered.layout, index, viewportWidth);
        })}
      </div>
    );
  }

  return (
    <ImageMimeProvider types={content.assetMimeTypes}>
      <svg
        ref={element}
        aria-hidden="true"
        className="h-full w-full"
        viewBox={`${crop.x} ${crop.y} ${crop.width} ${crop.height}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <foreignObject x={crop.x} y={crop.y} width={crop.width} height={crop.height}>
          <div style={{ position: "relative", width: crop.width, height: crop.height }}>
            {roots.map((root) => draw(root))}
          </div>
        </foreignObject>
      </svg>
    </ImageMimeProvider>
  );
}
