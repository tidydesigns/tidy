import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { Button } from "@tidy/ui/button";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import { PreviewCamera } from "./camera";
import {
  constrainGeometry,
  resizeEdges,
  resizeGeometry,
  type ResizeEdge,
  type DockSlot,
  type PreviewWindowGeometry,
} from "./window-geometry";
import type { PreviewCameraMemory } from "./navigation";
import { gestureMoved } from "./pointer";
import type {
  DesktopAPI,
  DesignSummary,
  LocalDesign,
} from "../../../../../shared/contracts/desktop";
import { LocalCanvas } from "../local-canvas";
import { preloadCanvasEditor } from "../load-canvas-editor";
import type { CanvasViewportMemory } from "@tidy/editor";
import type { CanvasGeometry } from "./dock-state";

type Phase = "closed" | "opening" | "open" | "closing";
const enterEasing = "cubic-bezier(0.6, 0.04, 0.85, 0.24)";
const exitEasing = "cubic-bezier(0.15, 0.65, 0.3, 1)";
const previewRatio = 1.5;
const minimiseIcon = (
  <svg
    aria-hidden="true"
    width="18"
    height="18"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 8h5V3m9 9h-5v5M8 8 3 3m9 9 5 5" />
  </svg>
);

function compactCanvasTransform(surface: HTMLElement, canvas: HTMLElement, button: HTMLElement) {
  const rect = button.getBoundingClientRect();
  const transform = getComputedStyle(canvas).transform;
  const current = new DOMMatrix(transform === "none" ? undefined : transform);
  const contentBounds = canvas.getBoundingClientRect();
  const roots = button.querySelectorAll<HTMLElement>("foreignObject > div > [data-thumbnail-node]");
  for (const root of roots) {
    const nodeId = root.dataset.thumbnailNode;
    if (!nodeId) continue;
    const node = canvas.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
    if (!node) continue;
    const source = root.getBoundingClientRect();
    const target = node.getBoundingClientRect();
    if (!source.width || !target.width) continue;
    const scale = source.width / (target.width / current.a);
    const x = source.left - ((target.left - contentBounds.left) / current.a) * scale;
    const y = source.top - ((target.top - contentBounds.top) / current.d) * scale;
    return `translate(${x}px, ${y}px) scale(${scale})`;
  }
  const scale =
    Math.min(rect.width / surface.clientWidth, rect.height / surface.clientHeight) * 0.68;
  return `translate(${rect.left + rect.width / 2 - (surface.clientWidth * scale) / 2}px, ${rect.top + rect.height / 2 - (surface.clientHeight * scale) / 2}px) scale(${scale})`;
}

export const ThreadDesignWindow = memo(function ThreadDesignWindow({
  api,
  projectId,
  summary,
  active,
  working,
  floating,
  warm,
  slot,
  placement,
  stackOrder,
  initialGeometry,
  viewportMemory,
  previewMemory,
  dockTarget,
  readPreview,
  onDock,
  onActivate,
  onGeometry,
  onDocked,
  onUpdate,
  onPreviewError,
}: {
  api: DesktopAPI;
  projectId: string;
  summary: DesignSummary;
  active: boolean;
  working: boolean;
  floating: boolean;
  warm: boolean;
  slot: DockSlot;
  placement: number;
  stackOrder: number;
  initialGeometry?: CanvasGeometry;
  viewportMemory: CanvasViewportMemory;
  previewMemory: PreviewCameraMemory;
  dockTarget: RefObject<HTMLSpanElement | null>;
  readPreview(summary: DesignSummary): Promise<LocalDesign>;
  onDock(id: string): void;
  onActivate(id: string): void;
  onGeometry(id: string, geometry: CanvasGeometry): void;
  onDocked(id: string): void;
  onUpdate(design: LocalDesign): void;
  onPreviewError(error: unknown): void;
}) {
  const [value, setValue] = useState<LocalDesign>();
  const [phase, setPhase] = useState<Phase>("closed");
  const [visited, setVisited] = useState(false);
  const layer = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const gestureFrame = useRef(0);
  const pendingGesture = useRef<(() => void) | undefined>(undefined);
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const transitionEdge = useRef<HTMLDivElement>(null);
  const animations = useRef<Animation[]>([]);
  const generation = useRef(0);
  const openRequest = useRef(0);
  const restoreFocus = useRef(false);
  const offset = useRef({
    x: initialGeometry?.x ?? Number.NaN,
    y: initialGeometry?.y ?? 64 + (placement % 5) * 28,
  });
  const width = useRef(initialGeometry?.width ?? 296);
  const height = useRef(initialGeometry?.height ?? width.current / previewRatio);
  const dockMotion = useRef<Animation[]>([]);
  const laidOut = useRef(false);
  const previousFloating = useRef(floating);
  const drag = useRef<{
    kind: "move" | ResizeEdge;
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    width: number;
    height: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const id = useId();
  const expanded = phase !== "closed";
  const ready = Boolean(summary && value?.id === summary.id);

  useLayoutEffect(
    () => () => {
      openRequest.current++;
    },
    [active, floating, warm, summary.id],
  );

  useEffect(() => {
    if (!ready || !active || !warm || !floating || visited) return;
    const idle = window.requestIdleCallback(() => setVisited(true), { timeout: 400 });
    return () => window.cancelIdleCallback(idle);
  }, [ready, active, warm, floating, visited]);

  const applyGeometry = useCallback((geometry: PreviewWindowGeometry) => {
    const surface = frame.current;
    const area = layer.current;
    if (!surface || !area || !area.clientWidth || !area.clientHeight) return;
    const next = constrainGeometry(geometry, {
      width: area.clientWidth,
      height: area.clientHeight,
    });
    offset.current = { x: next.x, y: next.y };
    width.current = next.width;
    height.current = next.height;
    Object.assign(surface.style, {
      left: "0px",
      top: "0px",
      width: `${next.width}px`,
      height: `${next.height}px`,
      transform: `translate(${next.x}px, ${next.y}px)`,
    });
  }, []);
  const move = useCallback(
    (x: number, y: number) => {
      applyGeometry({ x, y, width: width.current, height: height.current });
    },
    [applyGeometry],
  );
  const scheduleGesture = (update: () => void) => {
    pendingGesture.current = update;
    if (gestureFrame.current) return;
    gestureFrame.current = requestAnimationFrame(() => {
      gestureFrame.current = 0;
      pendingGesture.current?.();
      pendingGesture.current = undefined;
    });
  };
  const flushGesture = () => {
    cancelAnimationFrame(gestureFrame.current);
    gestureFrame.current = 0;
    pendingGesture.current?.();
    pendingGesture.current = undefined;
  };

  useLayoutEffect(() => {
    const surface = frame.current;
    const area = layer.current;
    if (!surface || !area || !active) return;
    const bounds = area.getBoundingClientRect();
    const previous = laidOut.current
      ? surface.getBoundingClientRect()
      : {
          left: bounds.left + slot.x,
          top: bounds.top + slot.y,
          width: slot.width,
          height: slot.width / previewRatio,
        };
    const previousOpacity = !laidOut.current
      ? "0"
      : dockMotion.current.length
        ? getComputedStyle(surface).opacity
        : previousFloating.current
          ? "1"
          : "0";
    const previousClip = getComputedStyle(surface).clipPath;
    const previousRadius = laidOut.current ? getComputedStyle(surface).borderRadius : "4px";
    dockMotion.current.forEach((motion) => motion.cancel());
    if (!Number.isFinite(offset.current.x)) {
      offset.current.x = area.clientWidth - width.current - 36 - (placement % 5) * 28;
      const composer = dockTarget.current?.closest("form")?.getBoundingClientRect();
      if (composer)
        offset.current.y = Math.max(
          16,
          Math.min(offset.current.y, composer.top - bounds.top - height.current - 16),
        );
    }
    const geometry = constrainGeometry(
      { ...offset.current, width: width.current, height: height.current },
      { width: area.clientWidth, height: area.clientHeight },
    );
    offset.current = { x: geometry.x, y: geometry.y };
    width.current = geometry.width;
    height.current = geometry.height;
    const target = floating ? geometry : { ...slot, height: slot.width / previewRatio };
    const targetHeight = target.height;
    const transform = `translate(${target.x}px, ${target.y}px)`;
    const clip = "inset(0% 0% 0% 0%)";
    Object.assign(surface.style, {
      left: "0px",
      top: "0px",
      width: `${target.width}px`,
      height: `${targetHeight}px`,
      transform,
      clipPath: clip,
      borderRadius: floating ? "14px" : "4px",
    });
    if (
      (laidOut.current || floating) &&
      previous.width &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      surface.dataset.moving = "true";
      const motion = surface.animate(
        [
          {
            transform: `translate(${previous.left - bounds.left}px, ${previous.top - bounds.top}px) scale(${previous.width / target.width}, ${previous.height / targetHeight})`,
            clipPath: previousClip === "none" ? "inset(0% 0% 0% 0%)" : previousClip,
            borderRadius: `${(parseFloat(previousRadius) * target.width) / previous.width}px`,
          },
          { transform, clipPath: clip, borderRadius: floating ? "14px" : "4px" },
        ],
        { duration: 280, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "both" },
      );
      const opacity = surface.animate(
        floating
          ? [{ opacity: previousOpacity }, { opacity: 1, offset: 0.3 }, { opacity: 1 }]
          : [
              { opacity: previousOpacity },
              { opacity: previousOpacity, offset: 0.7 },
              { opacity: 0 },
            ],
        { duration: 280, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "both" },
      );
      dockMotion.current = [motion, opacity];
      void motion.finished.then(
        () => {
          if (dockMotion.current[0] !== motion) return;
          delete surface.dataset.moving;
          dockMotion.current.forEach((animation) => animation.cancel());
          dockMotion.current = [];
          if (!floating) onDocked(summary.id);
        },
        () => {},
      );
    } else {
      delete surface.dataset.moving;
      if (!floating) onDocked(summary.id);
    }
    laidOut.current = true;
    if (!floating && previousFloating.current && surface.contains(document.activeElement))
      dockTarget.current
        ?.querySelector<HTMLButtonElement>(".canvas-dock-trigger")
        ?.focus({ preventScroll: true });
    previousFloating.current = floating;
  }, [floating, slot.x, slot.y, slot.width, active, onDocked, summary.id, dockTarget, placement]);

  useEffect(() => {
    if (!active || !floating || !layer.current) return;
    const observer = new ResizeObserver(() => {
      if (!drag.current)
        applyGeometry({ ...offset.current, width: width.current, height: height.current });
    });
    observer.observe(layer.current);
    return () => observer.disconnect();
  }, [active, floating, applyGeometry]);

  const remember = () =>
    onGeometry(summary.id, { ...offset.current, width: width.current, height: height.current });
  function acceptsDock(x: number, y: number) {
    const rect = dockTarget.current?.getBoundingClientRect();
    return Boolean(
      rect &&
      x >= rect.left - 20 &&
      x <= rect.right + 20 &&
      y >= rect.top - 20 &&
      y <= rect.bottom + 20,
    );
  }

  function beginDrag(event: PointerEvent<HTMLElement>, kind: "move" | ResizeEdge) {
    if (!floating) return;
    onActivate(summary.id);
    if (event.button !== 0 || !event.isPrimary || drag.current) return;
    dockMotion.current.forEach((motion) => motion.cancel());
    dockMotion.current = [];
    if (frame.current) delete frame.current.dataset.moving;
    suppressClick.current = false;
    drag.current = {
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      ...offset.current,
      width: frame.current?.getBoundingClientRect().width ?? width.current,
      height: height.current,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function continueDrag(event: PointerEvent<HTMLElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moved && !gestureMoved(dx, dy)) return;
    current.moved = true;
    if (current.kind === "move") {
      if (frame.current) frame.current.dataset.dragging = "true";
      scheduleGesture(() => move(current.x + dx, current.y + dy));
      if (dockTarget.current)
        dockTarget.current.dataset.canvasDrop = String(acceptsDock(event.clientX, event.clientY));
    } else {
      if (frame.current) frame.current.dataset.resizing = "true";
      const area = layer.current;
      if (area) {
        const next = resizeGeometry(current, current.kind, dx, dy, {
          width: area.clientWidth,
          height: area.clientHeight,
        });
        scheduleGesture(() => applyGeometry(next));
      }
    }
  }

  function finishDrag(event: PointerEvent<HTMLElement>, cancelled = false) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    flushGesture();
    suppressClick.current = current.moved || cancelled;
    drag.current = null;
    if (dockTarget.current) delete dockTarget.current.dataset.canvasDrop;
    if (current.moved) {
      const dropped =
        !cancelled && current.kind === "move" && acceptsDock(event.clientX, event.clientY);
      if (dropped) offset.current = { x: current.x, y: current.y };
      remember();
      if (dropped) onDock(summary.id);
    }
    if (frame.current) {
      delete frame.current.dataset.dragging;
      delete frame.current.dataset.resizing;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const update = useCallback(
    (design: LocalDesign) => {
      setValue(design);
      onUpdate(design);
    },
    [onUpdate],
  );

  useEffect(() => {
    if (!active) return;
    let current = true;
    void readPreview(summary).then(
      (design) => {
        if (current) setValue(design);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [readPreview, summary.id, summary.updatedAt, active]);

  const closeImmediately = useCallback(() => {
    generation.current++;
    animations.current.forEach((motion) => motion.cancel());
    animations.current = [];
    dialog.current?.close();
    if (dialog.current) dialog.current.style.clipPath = "";
    if (canvas.current) canvas.current.style.transform = "";
    transitionEdge.current?.removeAttribute("style");
    setPhase("closed");
  }, []);

  useEffect(() => {
    if (!active || !floating) closeImmediately();
  }, [active, floating, closeImmediately]);
  useEffect(() => {
    if (phase === "open")
      dialog.current
        ?.querySelector<HTMLButtonElement>("[data-canvas-back]")
        ?.focus({ preventScroll: true });
    if (phase === "closed" && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus({ preventScroll: true });
    }
  }, [phase]);
  useEffect(
    () => () => {
      generation.current++;
      cancelAnimationFrame(gestureFrame.current);
      animations.current.forEach((motion) => motion.cancel());
      dockMotion.current.forEach((motion) => motion.cancel());
    },
    [],
  );

  const transition = useCallback((open: boolean) => {
    const surface = dialog.current;
    const button = trigger.current;
    const content = canvas.current;
    const edge = transitionEdge.current;
    if (!surface || !button || !content || !edge) return;
    flushSync(() => setVisited(true));
    const epoch = ++generation.current;
    const rect = button.getBoundingClientRect();
    const corners = getComputedStyle(button).borderTopLeftRadius.split(" ");
    const radius = (value: string, size: number) =>
      parseFloat(value) * (value.endsWith("%") ? size / 100 : 1);
    const cornerRadius = `${radius(corners[0], rect.width)}px / ${radius(corners[1] ?? corners[0], rect.height)}px`;
    const compactClip = `inset(${rect.top}px ${surface.clientWidth - rect.right}px ${surface.clientHeight - rect.bottom}px ${rect.left}px round ${cornerRadius})`;
    const fullClip = "inset(0px 0px 0px 0px round 0px)";
    const compactEdge = {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      borderRadius: cornerRadius,
    };
    const fullEdge = {
      left: "0px",
      top: "0px",
      width: `${surface.clientWidth}px`,
      height: `${surface.clientHeight}px`,
      borderRadius: "0px",
    };
    const measuredEdge = getComputedStyle(edge);
    const previousEdge = surface.open
      ? {
          left: measuredEdge.left,
          top: measuredEdge.top,
          width: measuredEdge.width,
          height: measuredEdge.height,
          borderRadius: measuredEdge.borderRadius,
        }
      : compactEdge;
    const compactTransform = compactCanvasTransform(surface, content, button);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const previousOpacity = surface.open ? getComputedStyle(surface).opacity : "0";
    const measuredClip = getComputedStyle(surface).clipPath;
    const previousClip = surface.open
      ? measuredClip === "none"
        ? fullClip
        : measuredClip
      : compactClip;
    const previousTransform = surface.open ? getComputedStyle(content).transform : compactTransform;
    const chrome = [
      ...content.querySelectorAll<HTMLElement>("[data-canvas-control], .editor-panel"),
    ];
    const chromeOpacity = chrome.map((element) => getComputedStyle(element).opacity);
    animations.current.forEach((motion) => motion.cancel());
    surface.style.clipPath = reduced ? fullClip : previousClip;
    content.style.transform = reduced ? "none" : previousTransform;
    Object.assign(edge.style, reduced ? fullEdge : previousEdge);
    const previewRim = button
      .querySelector(".thread-design-rim")
      ?.getAnimations({ subtree: true })[0];
    const growingRim = edge.getAnimations({ subtree: true })[0];
    if (previewRim && growingRim && previewRim.currentTime !== null)
      growingRim.currentTime = previewRim.currentTime;
    if (open && !surface.open) surface.showModal();
    flushSync(() => setPhase(open ? "opening" : "closing"));
    const duration = reduced ? 100 : open ? 480 : 360;
    const timing = { duration, easing: open ? enterEasing : exitEasing, fill: "both" as const };
    const aperture = surface.animate(
      reduced
        ? [{ opacity: previousOpacity }, { opacity: open ? 1 : 0 }]
        : [{ clipPath: previousClip }, { clipPath: open ? fullClip : compactClip }],
      timing,
    );
    const artwork = content.animate(
      reduced
        ? [{ transform: "none" }, { transform: "none" }]
        : [{ transform: previousTransform }, { transform: open ? "none" : compactTransform }],
      timing,
    );
    const outline = edge.animate(
      reduced ? [fullEdge, fullEdge] : [previousEdge, open ? fullEdge : compactEdge],
      timing,
    );
    const controls = chrome.map((element, index) =>
      element.animate([{ opacity: open ? 0 : chromeOpacity[index] }, { opacity: open ? 1 : 0 }], {
        duration: 70,
        delay: open && !reduced ? duration - 70 : 0,
        fill: "both",
      }),
    );
    const motions = [aperture, artwork, outline, ...controls];
    animations.current = motions;
    void Promise.all([aperture.finished, artwork.finished, outline.finished]).then(
      () => {
        if (generation.current !== epoch) return;
        surface.style.clipPath = open ? fullClip : compactClip;
        content.style.transform = open ? "none" : compactTransform;
        if (open) {
          flushSync(() => setPhase("open"));
        } else {
          restoreFocus.current = true;
          surface.close();
          flushSync(() => setPhase("closed"));
        }
        motions.forEach((motion) => motion.cancel());
        animations.current = [];
        surface.style.clipPath = "";
        content.style.transform = "";
        edge.removeAttribute("style");
      },
      () => {},
    );
  }, []);
  const minimise = useCallback(() => transition(false), [transition]);

  return (
    <div
      ref={layer}
      className="thread-design-window"
      data-working={working}
      data-floating={floating}
      hidden={!active}
      style={{ zIndex: stackOrder }}
    >
      <div
        ref={frame}
        className="thread-design-frame"
        data-expanded={expanded}
        data-docked={!floating}
        aria-hidden={!floating || undefined}
        inert={!floating}
      >
        <Button
          ref={trigger}
          onPointerEnter={preloadCanvasEditor}
          onFocus={preloadCanvasEditor}
          type="button"
          className="thread-design-peek"
          aria-label={floating ? "Expand canvas" : `Open ${summary.name} preview`}
          aria-busy={!ready || undefined}
          aria-haspopup={floating ? "dialog" : undefined}
          aria-controls={floating ? id : undefined}
          aria-expanded={expanded}
          aria-description={
            floating
              ? `Live view of ${summary.name}. Scroll to pan, pinch to zoom, Space and drag to pan, or click to expand.`
              : `Restore the live view of ${summary.name}.`
          }
          data-expanded={expanded}
          onClick={(event) => {
            if (!suppressClick.current || event.detail === 0) {
              if (!warm) flushSync(() => onActivate(summary.id));
              if (ready) transition(true);
              else {
                const request = ++openRequest.current;
                void readPreview(summary).then(
                  (design) => {
                    if (request !== openRequest.current) return;
                    flushSync(() => setValue(design));
                    transition(true);
                  },
                  () => {},
                );
              }
            }
            suppressClick.current = false;
          }}
        >
          <span className="thread-design-lens" aria-hidden="true" inert>
            <span className="thread-design-artwork">
              {value && (
                <PreviewCamera
                  onError={onPreviewError}
                  value={value}
                  memory={previewMemory}
                  surface={trigger}
                  suppressClick={suppressClick}
                  enabled={active && floating && !expanded}
                />
              )}
            </span>
          </span>
          <span className="thread-design-rim" aria-hidden="true" />
        </Button>
        <div
          className="thread-design-header"
          onPointerDown={(event) => {
            if (event.target instanceof Element && event.target.closest("button")) return;
            beginDrag(event, "move");
          }}
          onPointerMove={continueDrag}
          onPointerUp={(event) => finishDrag(event)}
          onPointerCancel={(event) => finishDrag(event, true)}
          onLostPointerCapture={(event) => finishDrag(event, true)}
        >
          <span className="thread-design-name" title={summary.name}>
            {summary.name}
          </span>
          <Button
            type="button"
            className="thread-design-close"
            aria-label="Dock preview"
            onClick={() => {
              remember();
              onDock(summary.id);
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              aria-hidden="true"
            >
              <path d="m3 4.5 3 3 3-3" />
            </svg>
          </Button>
        </div>
        {resizeEdges.map((edge) => (
          <Button
            key={edge}
            type="button"
            className="thread-design-resize"
            data-edge={edge}
            aria-label={`Resize preview ${edge}`}
            tabIndex={edge === "se" ? 0 : -1}
            onPointerDown={(event) => beginDrag(event, edge)}
            onPointerMove={continueDrag}
            onPointerUp={(event) => finishDrag(event)}
            onPointerCancel={(event) => finishDrag(event, true)}
            onLostPointerCapture={(event) => finishDrag(event, true)}
            onKeyDown={(event) => {
              const directions: Record<string, [number, number]> = {
                ArrowLeft: [-1, 0],
                ArrowRight: [1, 0],
                ArrowUp: [0, -1],
                ArrowDown: [0, 1],
              };
              const direction = directions[event.key];
              const area = layer.current;
              if (!direction || !area) return;
              event.preventDefault();
              event.stopPropagation();
              const step = event.shiftKey ? 40 : 16;
              applyGeometry(
                resizeGeometry(
                  { ...offset.current, width: width.current, height: height.current },
                  edge,
                  direction[0] * step,
                  direction[1] * step,
                  { width: area.clientWidth, height: area.clientHeight },
                ),
              );
              remember();
            }}
          />
        ))}
      </div>
      <Dialog
        ref={dialog}
        id={id}
        padded={false}
        className="thread-design-dialog"
        aria-label="Live design canvas"
        aria-hidden={phase === "closed" || undefined}
        style={{ opacity: phase === "closed" ? 0 : 1 }}
        data-phase={phase}
        onCancel={(event) => {
          event.preventDefault();
          transition(false);
        }}
        onClose={() => {
          if (dialog.current?.open) return;
          setPhase("closed");
        }}
      >
        <div ref={canvas} className="thread-design-canvas" inert={phase !== "open"}>
          {visited && warm && active && value && (
            <LocalCanvas
              key={value.id}
              api={api}
              projectId={projectId}
              initial={value}
              active={phase === "open"}
              initialPanelsOpen={false}
              viewportMemory={viewportMemory}
              backLabel="Minimise canvas"
              backIcon={minimiseIcon}
              onBack={minimise}
              onUpdate={update}
            />
          )}
        </div>
        <div
          ref={transitionEdge}
          className="thread-design-transition-edge"
          aria-hidden="true"
          inert
        >
          <span className="thread-design-rim" />
        </div>
      </Dialog>
    </div>
  );
});
