"use client";
import { DocumentPreview } from "@tidy/editor/components/files/document-preview";
export { DocumentPreview } from "@tidy/editor/components/files/document-preview";
import { textFontSegments } from "@tidy/design/rich-text-runtime";
import { useEffect, useRef } from "react";
import type { DesignDocument } from "@/lib/design/document";
import { fontRegistry } from "@/lib/design/fonts/runtime";
import { embedDesignImages } from "@/lib/design/export-images";
import { resolvedDocumentNodes } from "@/lib/design/design-tokens";
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
