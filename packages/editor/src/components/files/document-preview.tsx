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
import { nodeEffects, nodeShadows } from "@tidy/design/effects";
import { documentPage, pageNodes } from "../../design/pages";
import { resolvedColorTokens, resolvedDocumentNodes } from "@tidy/design/design-tokens";
import { useDocumentFonts } from "../../design/fonts/use-document-fonts";
const hostedAssetUrl = (id: string) => `/api/assets/${id}`;
export type PreviewViewport = { x: number; y: number; zoom: number; width: number; height: number };
export type PreviewBounds = DesignNode["box"];
function bounds(boxes: PreviewBounds[]): PreviewBounds {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function clipsChildren(node: DesignNode) {
  return (
    node.style.overflow === "hidden" ||
    node.style.overflow === "auto" ||
    (node.style.overflow === undefined && (node.type === "artboard" || node.type === "image"))
  );
}

function blurOutset(node: DesignNode) {
  return nodeEffects(node.style).reduce(
    (sum, effect) => sum + (effect.visible && effect.type === "blur" ? effect.amount * 3 : 0),
    0,
  );
}

type LinearTransform = { a: number; b: number; c: number; d: number };
const identity: LinearTransform = { a: 1, b: 0, c: 0, d: 1 };

function paintTransform(node: DesignNode, parent: LinearTransform): LinearTransform {
  const angle = ((node.style.rotation ?? 0) * Math.PI) / 180;
  const x = node.style.flipX ? -1 : 1;
  const y = node.style.flipY ? -1 : 1;
  const a = Math.cos(angle) * x;
  const b = Math.sin(angle) * x;
  const c = -Math.sin(angle) * y;
  const d = Math.cos(angle) * y;
  return {
    a: parent.a * a + parent.c * b,
    b: parent.b * a + parent.d * b,
    c: parent.a * c + parent.c * d,
    d: parent.b * c + parent.d * d,
  };
}

function paintOutsets(node: DesignNode, transform: LinearTransform) {
  const stroke = strokeOutsets(node);
  let top = stroke[0] ?? 0,
    right = stroke[1] ?? 0,
    bottom = stroke[2] ?? 0,
    left = stroke[3] ?? 0;
  for (const shadow of nodeShadows(node.style)) {
    if (!shadow.visible || shadow.inset) continue;
    const spread = shadow.blur * 1.5 + shadow.spread;
    top = Math.max(top, spread - shadow.y);
    right = Math.max(right, spread + shadow.x);
    bottom = Math.max(bottom, spread + shadow.y);
    left = Math.max(left, spread - shadow.x);
  }
  const blur = blurOutset(node);
  const outline = node.style.outlineWidth ?? 0;
  top = Math.max(top, outline) + blur;
  right = Math.max(right, outline) + blur;
  bottom = Math.max(bottom, outline) + blur;
  left = Math.max(left, outline) + blur;
  const { a, b, c, d } = transform;
  return [
    Math.max(b * left, -b * right) + Math.max(d * top, -d * bottom),
    Math.max(-a * left, a * right) + Math.max(-c * top, c * bottom),
    Math.max(-b * left, b * right) + Math.max(-d * top, d * bottom),
    Math.max(a * left, -a * right) + Math.max(c * top, -c * bottom),
  ] as const;
}

export function DocumentPreview({
  content,
  assetUrl = hostedAssetUrl,
  viewport,
  onBounds,
  pageId,
}: {
  content: DesignDocument;
  assetUrl?: (id: string) => string;
  viewport?: PreviewViewport;
  onBounds?: (bounds: PreviewBounds) => void;
  pageId?: string;
}) {
  const element = useRef<SVGSVGElement>(null);
  const scene = useRef<SVGGElement>(null);
  const [measurement, setMeasurement] = useState<{
    page: DesignNode[];
    boxes: Map<string, PreviewBounds>;
  }>();
  const renderedContent = useMemo(
    () => ({
      ...content,
      nodes: resolvedDocumentNodes(content),
    }),
    [content],
  );
  const colors = useMemo(() => resolvedColorTokens(content), [content]);
  const page = useMemo(
    () => pageNodes(renderedContent, documentPage(renderedContent, pageId).id),
    [renderedContent, pageId],
  );
  useDocumentFonts(page);
  useLayoutEffect(() => {
    const children = childrenByParent(page);
    const candidates = new Set<string>();
    function visit(node: DesignNode, frameWidth = node.box.width) {
      if (!node.visible || node.style.opacity === 0) return;
      candidates.add(node.id);
      const width = node.type === "artboard" ? node.box.width : frameWidth;
      if (clipsChildren(responsiveNode(node, width))) return;
      if (node.vectorBoolean) return;
      for (const child of children.get(node.id) ?? [])
        if (!node.mask?.enabled || node.mask.sourceId !== child.id) visit(child, width);
    }
    for (const node of page) if (node.parentId === null) visit(node);
    const layers = [
      ...(element.current?.querySelectorAll<HTMLElement>("[data-thumbnail-node]") ?? []),
    ].flatMap((layer) => {
      const id = layer.dataset.thumbnailNode;
      return id && candidates.has(id) ? [{ id, layer }] : [];
    });
    const measure = () => {
      const matrix = scene.current?.getScreenCTM();
      if (!matrix || matrix.a * matrix.d - matrix.b * matrix.c === 0) return;
      const inverse = matrix.inverse();
      const next = new Map(
        layers.flatMap(({ id, layer }) => {
          const rect = layer.getBoundingClientRect();
          const points = [
            new DOMPoint(rect.left, rect.top),
            new DOMPoint(rect.right, rect.top),
            new DOMPoint(rect.right, rect.bottom),
            new DOMPoint(rect.left, rect.bottom),
          ].map((point) => point.matrixTransform(inverse));
          const x = Math.min(...points.map((point) => point.x));
          const y = Math.min(...points.map((point) => point.y));
          const width = Math.max(...points.map((point) => point.x)) - x;
          const height = Math.max(...points.map((point) => point.y)) - y;
          return [x, y, width, height].every(Number.isFinite)
            ? [[id, { x, y, width, height }] as const]
            : [];
        }),
      );
      setMeasurement((previous) =>
        previous?.page === page &&
        previous.boxes.size === next.size &&
        [...next].every(([id, box]) => {
          const before = previous.boxes.get(id);
          return (
            before &&
            Math.abs(before.x - box.x) < 0.01 &&
            Math.abs(before.y - box.y) < 0.01 &&
            Math.abs(before.width - box.width) < 0.01 &&
            Math.abs(before.height - box.height) < 0.01
          );
        })
          ? previous
          : { page, boxes: next },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    layers.forEach(({ layer }) => observer.observe(layer));
    return () => observer.disconnect();
  }, [page]);
  const measured = measurement?.page === page ? measurement.boxes : undefined;
  const artworkTree = useMemo(
    () => ({
      roots: page.filter(
        (node) => node.parentId === null && node.visible && node.style.opacity !== 0,
      ),
      children: childrenByParent(page),
      byId: new Map(page.map((node) => [node.id, node])),
    }),
    [page],
  );
  const preview = useMemo(() => {
    const { roots, children } = artworkTree;
    if (!roots.length) return null;
    const visibleBoxes: PreviewBounds[] = [];
    function collect(
      node: DesignNode,
      x: number,
      y: number,
      frameWidth = node.box.width,
      parentTransform = identity,
      inheritedBlur = { x: 0, y: 0 },
    ) {
      if (!node.visible || node.style.opacity === 0) return;
      const viewportWidth = node.type === "artboard" ? node.box.width : frameWidth;
      const rendered = responsiveNode(
        booleanRenderNode(node, renderedContent.nodes),
        viewportWidth,
      );
      const absolute = measured?.get(node.id) ?? {
        ...node.box,
        x: x + node.box.x,
        y: y + node.box.y,
      };
      const transform = paintTransform(rendered, parentTransform);
      const [top, right, bottom, left] = paintOutsets(rendered, transform);
      visibleBoxes.push({
        x: absolute.x - left - inheritedBlur.x,
        y: absolute.y - top - inheritedBlur.y,
        width: absolute.width + left + right + inheritedBlur.x * 2,
        height: absolute.height + top + bottom + inheritedBlur.y * 2,
      });
      if (clipsChildren(rendered) || node.vectorBoolean) return;
      const blur = blurOutset(rendered);
      const descendantBlur = {
        x: inheritedBlur.x + blur * (Math.abs(transform.a) + Math.abs(transform.c)),
        y: inheritedBlur.y + blur * (Math.abs(transform.b) + Math.abs(transform.d)),
      };
      for (const child of children.get(node.id) ?? [])
        if (!node.mask?.enabled || node.mask.sourceId !== child.id)
          collect(child, absolute.x, absolute.y, viewportWidth, transform, descendantBlur);
    }
    for (const root of roots) collect(root, 0, 0);
    const area = bounds(visibleBoxes);
    const margin = Math.max(24, Math.min(area.width, area.height) * 0.08);
    return {
      crop: {
        x: area.x - margin,
        y: area.y - margin,
        width: Math.max(1, area.width + margin * 2),
        height: Math.max(1, area.height + margin * 2),
      },
    };
  }, [artworkTree, measured, renderedContent]);
  useLayoutEffect(() => {
    if (preview && measured) onBounds?.(preview.crop);
  }, [preview, measured, onBounds]);
  const crop = preview?.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const artwork = useMemo(() => {
    const { children, byId, roots } = artworkTree;
    function draw(
      node: DesignNode,
      parentLayout: DesignNode["layout"] = "absolute",
      flowIndex = 0,
      frameWidth = node.box.width,
    ): React.ReactNode {
      if (!node.visible) return null;
      const viewportWidth = node.type === "artboard" ? node.box.width : frameWidth;
      const rendered = responsiveNode(
        booleanRenderNode(node, renderedContent.nodes),
        viewportWidth,
      );
      const parent = byId.get(node.parentId ?? "");
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
      let childFlowIndex = 0;
      return (
        <div key={node.id} data-thumbnail-node={node.id} style={style}>
          <NodeStrokes node={rendered} tokens={colors} />
          <NodeFills node={rendered} tokens={colors} assetUrl={assetUrl} />
          {node.type === "text" ? (
            <DesignText node={node} interactiveLinks={false} />
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

    return roots.map((root) => draw(root));
  }, [artworkTree, renderedContent, colors, assetUrl]);
  if (!preview) return null;
  return (
    <ImageMimeProvider types={content.assetMimeTypes}>
      <svg
        ref={element}
        aria-hidden="true"
        data-preview-page={documentPage(renderedContent, pageId).id}
        className="h-full w-full"
        viewBox={
          viewport
            ? `0 0 ${viewport.width} ${viewport.height}`
            : `${crop.x} ${crop.y} ${crop.width} ${crop.height}`
        }
        preserveAspectRatio="xMidYMid meet"
      >
        <g
          ref={scene}
          transform={
            viewport ? `translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})` : undefined
          }
        >
          <foreignObject x={crop.x} y={crop.y} width={crop.width} height={crop.height}>
            <div
              style={{
                position: "relative",
                left: -crop.x,
                top: -crop.y,
                width: crop.width,
                height: crop.height,
              }}
            >
              {artwork}
            </div>
          </foreignObject>
        </g>
      </svg>
    </ImageMimeProvider>
  );
}
