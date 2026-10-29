"use dom";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { DOMProps } from "expo/dom";
import { TidyDesign } from "@tidy/design-renderer/design";
import { nodePageId, type DesignDocument } from "@tidy/design/document";

type Point = { x: number; y: number };
export default function Canvas({
  document: design,
  assets,
  page,
  selected,
  editable,
  background,
  ink,
  onSelect,
  onMove,
}: {
  document: DesignDocument;
  assets: Record<string, string>;
  page: string;
  selected: string | null;
  editable: boolean;
  background: string;
  ink: string;
  dom?: DOMProps;
  onSelect(id: string | null): Promise<void>;
  onMove(id: string, x: number, y: number): Promise<void>;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState({ x: 24, y: 24, scale: 0.75 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const points = useRef(new Map<number, Point>());
  const gesture = useRef<{
    x: number;
    y: number;
    camera: typeof camera;
    id?: string;
    element?: HTMLElement;
    dx: number;
    dy: number;
    distance?: number;
    center?: Point;
  } | null>(null);
  const roots = useMemo(
    () =>
      design.nodes.filter((node) => !node.parentId && node.visible && nodePageId(node) === page),
    [design.nodes, page],
  );
  const [outline, setOutline] = useState<{ x: number; y: number; width: number; height: number }>();
  function fit() {
    const view = viewport.current;
    if (!view || !roots.length) return;
    const left = Math.min(...roots.map((node) => node.box.x)),
      top = Math.min(...roots.map((node) => node.box.y));
    const width = Math.max(...roots.map((node) => node.box.x + node.box.width)) - left;
    const height = Math.max(...roots.map((node) => node.box.y + node.box.height)) - top;
    const scale = Math.max(
      0.05,
      Math.min(1, (view.clientWidth - 48) / width, (view.clientHeight - 80) / height),
    );
    setCamera({
      x: (view.clientWidth - width * scale) / 2 - left * scale,
      y: (view.clientHeight - height * scale) / 2 - top * scale,
      scale,
    });
  }
  useEffect(() => {
    fit(); /* Fit once per page; edits retain the camera. */
  }, [page, roots.length > 0]);
  useEffect(() => {
    if (!selected || !viewport.current) {
      setOutline(undefined);
      return;
    }
    const node = world.current?.querySelector<HTMLElement>(
      `[data-prototype-node="${CSS.escape(selected)}"]`,
    );
    if (!node) {
      setOutline(undefined);
      return;
    }
    const update = () => {
      const bounds = node.getBoundingClientRect(),
        view = viewport.current!.getBoundingClientRect();
      setOutline({
        x: bounds.x - view.x,
        y: bounds.y - view.y,
        width: bounds.width,
        height: bounds.height,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [selected, design, camera]);
  // Only authenticated, downloaded assets enter the renderer. Cloud tokens stay native.
  const images = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(assets).filter(([, value]) =>
          /^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(value),
        ),
      ),
    [assets],
  );
  return (
    <div
      ref={viewport}
      aria-label="Design canvas"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background,
        touchAction: "none",
        userSelect: "none",
        color: ink,
      }}
      onClickCapture={(event) => event.preventDefault()}
      onSubmitCapture={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("[data-canvas-controls]")) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (points.current.size === 2) {
          const [a, b] = [...points.current.values()];
          if (gesture.current?.element) gesture.current.element.style.translate = "";
          gesture.current = {
            x: 0,
            y: 0,
            dx: 0,
            dy: 0,
            camera: cameraRef.current,
            distance: Math.hypot(a.x - b.x, a.y - b.y),
            center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          };
          return;
        }
        const element =
          (event.target as HTMLElement).closest<HTMLElement>("[data-prototype-node]") ?? undefined;
        const id = element?.dataset.prototypeNode;
        const node = design.nodes.find((item) => item.id === id),
          parent = design.nodes.find((item) => item.id === node?.parentId);
        const move =
          editable &&
          id === selected &&
          node &&
          !node.locked &&
          (!parent || parent.layout === "absolute");
        gesture.current = {
          x: event.clientX,
          y: event.clientY,
          camera: cameraRef.current,
          id: move ? id : undefined,
          element: move ? element : undefined,
          dx: 0,
          dy: 0,
        };
        if (id !== selected) void onSelect(id ?? null);
      }}
      onPointerMove={(event) => {
        const current = gesture.current;
        if (!current || !points.current.has(event.pointerId)) return;
        points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (points.current.size === 2 && current.distance && current.center) {
          const [a, b] = [...points.current.values()],
            box = viewport.current!.getBoundingClientRect();
          const scale = Math.max(
            0.05,
            Math.min(
              4,
              (current.camera.scale * Math.hypot(a.x - b.x, a.y - b.y)) / current.distance,
            ),
          );
          const ratio = scale / current.camera.scale;
          setCamera({
            scale,
            x: (a.x + b.x) / 2 - box.x - (current.center.x - box.x - current.camera.x) * ratio,
            y: (a.y + b.y) / 2 - box.y - (current.center.y - box.y - current.camera.y) * ratio,
          });
          return;
        }
        current.dx = event.clientX - current.x;
        current.dy = event.clientY - current.y;
        if (current.element)
          current.element.style.translate = `${current.dx / current.camera.scale}px ${current.dy / current.camera.scale}px`;
        else
          setCamera({
            ...current.camera,
            x: current.camera.x + current.dx,
            y: current.camera.y + current.dy,
          });
      }}
      onPointerUp={(event) => {
        points.current.delete(event.pointerId);
        const current = gesture.current;
        gesture.current = null;
        if (current?.element) {
          current.element.style.translate = "";
          const node = design.nodes.find((item) => item.id === current.id);
          if (node && (Math.abs(current.dx) > 2 || Math.abs(current.dy) > 2))
            void onMove(
              node.id,
              node.box.x + current.dx / current.camera.scale,
              node.box.y + current.dy / current.camera.scale,
            );
        }
      }}
      onPointerCancel={() => {
        if (gesture.current?.element) gesture.current.element.style.translate = "";
        gesture.current = null;
        points.current.clear();
      }}
      onWheel={(event) => {
        const view = viewport.current!.getBoundingClientRect(),
          old = cameraRef.current;
        const scale = Math.max(0.05, Math.min(4, old.scale * Math.exp(-event.deltaY / 500)));
        setCamera({
          scale,
          x: event.clientX - view.x - ((event.clientX - view.x - old.x) * scale) / old.scale,
          y: event.clientY - view.y - ((event.clientY - view.y - old.y) * scale) / old.scale,
        });
      }}
    >
      <style>{`html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}*{box-sizing:border-box}button,input,textarea{font:inherit}img{pointer-events:none}button:active{opacity:.7}`}</style>
      <div
        ref={world}
        style={{
          position: "absolute",
          transformOrigin: "0 0",
          transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.scale})`,
        }}
      >
        {roots.map((node) => (
          <div
            key={node.id}
            style={{
              position: "absolute",
              left: node.box.x,
              top: node.box.y,
              width: node.box.width,
              height: node.box.height,
            }}
          >
            <CanvasRoot
              document={design}
              rootId={node.id}
              assets={images}
              frameWidth={node.box.width}
              readOnly
            />
          </div>
        ))}
      </div>
      {outline && (
        <div
          style={{
            position: "absolute",
            pointerEvents: "none",
            left: outline.x,
            top: outline.y,
            width: outline.width,
            height: outline.height,
            outline: "1.5px solid #6958e8",
            outlineOffset: 1,
          }}
        />
      )}
      {!roots.length && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            pointerEvents: "none",
            fontFamily: "system-ui",
            opacity: 0.6,
          }}
        >
          Add a frame to start designing
        </div>
      )}
      <div
        data-canvas-controls
        style={{
          position: "absolute",
          bottom: 12,
          right: 12,
          background,
          border: "1px solid #8884",
          borderRadius: 8,
          display: "flex",
        }}
      >
        <button
          aria-label="Fit canvas"
          onClick={fit}
          style={{ minHeight: 44, minWidth: 64, border: 0, background: "transparent", color: ink }}
        >
          Fit
        </button>
        <span style={{ padding: 13, font: "13px system-ui", borderLeft: "1px solid #8884" }}>
          {Math.round(camera.scale * 100)}%
        </span>
      </div>
    </div>
  );
}

const noTrigger = () => false;
const CanvasRoot = memo(function CanvasRoot(props: Parameters<typeof TidyDesign>[0]) {
  return <TidyDesign {...props} onTrigger={noTrigger} />;
});
