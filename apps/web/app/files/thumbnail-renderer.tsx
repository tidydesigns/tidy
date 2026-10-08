"use client";
import { ImageMimeProvider } from "@tidy/design-renderer/image-context";
import { textFontSegments } from "@bella/design/rich-text";
import { booleanRenderNode, vectorCompositeStyle } from "@tidy/design-renderer/vector-composites";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { strokeOutsets } from "@/lib/design/strokes";
import { NodeStrokes } from "@/components/design/node-strokes";
import { NodeFills } from "@/components/design/node-fills";
import { DesignText } from "@/components/design/design-text";
import { DesignImage } from "@/components/design/design-image";
import type { DesignDocument, DesignNode } from "@/lib/design/document";
import { nodeStyle } from "@/lib/design/node-style";
import { documentPages, pageNodes } from "@/lib/design/pages";
import { useDocumentFonts } from "@/lib/design/fonts/use-document-fonts";
import { fontRegistry } from "@/lib/design/fonts/runtime";
import { embedDesignImages } from "@/lib/design/export-images";
import { responsiveNode } from "@/lib/design/responsive-layout";
import { resolvedColorTokens, resolvedDocumentNodes } from "@/lib/design/design-tokens";
export type Snapshot = {
  document: { content: DesignDocument; revision: number } | null;
  frames: Shape[];
  rectangles: Shape[];
};
type Box = { x: number; y: number; width: number; height: number };
type Shape = Box & { id: string };
function bounds(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function DocumentPreview({ content }: { content: DesignDocument }) {
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
    const children = new Map<string, DesignNode[]>();
    for (const node of nodes) {
      if (!node.parentId) continue;
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
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
      resolvedColorTokens(content),
      parent ? responsiveNode(parent, viewportWidth) : undefined,
      flowIndex,
    );
    Object.assign(
      style,
      vectorCompositeStyle(node, renderedContent.nodes, resolvedColorTokens(content), parent),
    );
    if (node.parentId === null) {
      style.left = node.box.x - crop.x;
      style.top = node.box.y - crop.y;
    }
    let childFlowIndex = 0;
    return (
      <div key={node.id} data-thumbnail-node={node.id} style={style}>
        <NodeStrokes node={rendered} tokens={resolvedColorTokens(content)} />
        <NodeFills node={rendered} tokens={resolvedColorTokens(content)} />
        {node.type === "text" ? (
          <DesignText node={node} />
        ) : (rendered.type === "image" || rendered.type === "vector") &&
          (node.assetId || rendered.vectorPath) ? (
          <DesignImage
            tokens={resolvedColorTokens(content)}
            node={rendered}
            src={`/api/assets/${node.assetId}`}
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

function LegacyPreview({ snapshot }: { snapshot: Snapshot }) {
  const shapes = [...snapshot.frames, ...snapshot.rectangles];
  const area = bounds(shapes);
  const margin = Math.max(20, Math.min(area.width, area.height) * 0.1);
  return (
    <svg
      aria-hidden="true"
      className="h-full w-full"
      viewBox={`${area.x - margin} ${area.y - margin} ${area.width + margin * 2} ${area.height + margin * 2}`}
    >
      {snapshot.frames.map((frame) => (
        <rect
          key={frame.id}
          x={frame.x}
          y={frame.y}
          width={frame.width}
          height={frame.height}
          fill="#ffffff"
          stroke="#c7c7c7"
        />
      ))}
      {snapshot.rectangles.map((rectangle) => (
        <rect
          key={rectangle.id}
          x={rectangle.x}
          y={rectangle.y}
          width={rectangle.width}
          height={rectangle.height}
          fill="#dedede"
          stroke="#b0b0b0"
        />
      ))}
    </svg>
  );
}

export function ThumbnailRenderer({
  snapshot,
  signal,
  onComplete,
  onError,
}: {
  snapshot: Snapshot;
  signal: AbortSignal;
  onComplete: (blob: Blob) => void;
  onError: (error: unknown) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    async function capture() {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (signal.aborted || !active) return;
      const original = container.current?.querySelector("svg");
      if (!original) {
        onComplete(await blankThumbnail());
        return;
      }
      const content = snapshot.document?.content;
      const byId = new Map(
        content ? resolvedDocumentNodes(content).map((node) => [node.id, node]) : [],
      );
      const fontNodes = [
        ...original.querySelectorAll<HTMLElement>("[data-thumbnail-node]"),
      ].flatMap((element) => {
        const node = byId.get(element.dataset.thumbnailNode!);
        return node?.type === "text" ? [node] : [];
      });
      const fontCss = await fontRegistry.exportCss(
        fontNodes.flatMap((node) =>
          textFontSegments({ ...node, text: node.text ?? "" }).map((segment) => ({
            family: node.style.fontFamily ?? "system-ui",
            weight: segment.weight,
            italic: segment.italic,
            text: segment.text,
            source: node.style.fontSource,
            face: segment.face,
          })),
        ),
      );
      // Loaded fonts can resize hug text; let the measured crop settle before cloning it.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (signal.aborted || !active) return;
      const clone = original.cloneNode(true) as SVGSVGElement;
      const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
      style.textContent = fontCss;
      clone.insertBefore(style, clone.firstChild);
      clone.setAttribute("width", "512");
      clone.setAttribute("height", "320");
      await embedDesignImages(clone as unknown as HTMLElement, signal);
      if (signal.aborted || !active) return;
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 320;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Thumbnail rendering is unavailable.");
      context.drawImage(image, 0, 0, 512, 320);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode thumbnail."))),
          "image/png",
        ),
      );
      if (active && !signal.aborted) onComplete(blob);
    }
    void capture().catch((error) => {
      if (active && !signal.aborted) onError(error);
    });
    return () => {
      active = false;
    };
  }, [snapshot, signal, onComplete, onError]);
  return (
    <div
      data-thumbnail-renderer
      ref={container}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 opacity-0"
    >
      {snapshot.document ? (
        <DocumentPreview content={snapshot.document.content} />
      ) : snapshot.frames.length || snapshot.rectangles.length ? (
        <LegacyPreview snapshot={snapshot} />
      ) : null}
    </div>
  );
}
async function blankThumbnail() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 320;
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode thumbnail."))),
      "image/png",
    ),
  );
}
