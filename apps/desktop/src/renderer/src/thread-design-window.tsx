import { useCallback, useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { flushSync } from "react-dom";
import { Button } from "@tidy/ui/button";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import { DocumentPreview } from "@tidy/editor/components/files/document-preview";
import { Icon } from "@tidy/editor/components/ui/icon";
import { threadDesign } from "../../shared/thread-design";
import type { DesktopAPI, DesignSummary, LocalDesign, Thread } from "../../shared/contracts";
import { LocalCanvas } from "./local-canvas";

type Phase = "closed" | "opening" | "open" | "closing";
const enterEasing = "cubic-bezier(0.7, 0, 0.85, 0.35)";
const exitEasing = "cubic-bezier(0.15, 0.65, 0.3, 1)";
const previewRatio = 1.5;
const minimumWidth = 220;
const maximumWidth = 560;

/** Align the live editor with the thumbnail before growing it into its full-size view. */
function compactCanvasTransform(surface: HTMLElement, canvas: HTMLElement, button: HTMLElement) {
  const rect = button.getBoundingClientRect();
  const transform = getComputedStyle(canvas).transform;
  const current = new DOMMatrix(transform === "none" ? undefined : transform);
  const contentBounds = canvas.getBoundingClientRect();
  const roots = button.querySelectorAll<HTMLElement>("foreignObject > div > [data-thumbnail-node]");
  for (const root of roots) {
    const node = canvas.querySelector<HTMLElement>(
      `[data-node-id="${CSS.escape(root.dataset.thumbnailNode!)}"]`,
    );
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

export function ThreadDesignWindow({
  api,
  thread,
  designs,
  active,
  onUpdate,
}: {
  api: DesktopAPI;
  thread: Thread;
  designs: DesignSummary[];
  active: boolean;
  onUpdate(design: LocalDesign): void;
}) {
  const candidate = threadDesign(thread, designs);
  // Keep the last window when the agent finishes, including an already expanded canvas.
  const [targetId, setTargetId] = useState<string>();
  const [value, setValue] = useState<LocalDesign>();
  const [phase, setPhase] = useState<Phase>("closed");
  const [visited, setVisited] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const layer = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const resizeHandle = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const animations = useRef<Animation[]>([]);
  const generation = useRef(0);
  const restoreFocus = useRef(false);
  const offset = useRef({ x: 0, y: 0 });
  const width = useRef(296);
  const drag = useRef<{
    kind: "move" | "resize";
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    width: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const id = useId();
  const expanded = phase !== "closed";
  const summary = designs.find((design) => design.id === targetId);
  const ready = Boolean(summary && value?.id === summary.id);

  useEffect(() => {
    if (!ready || !active || dismissed || visited) return;
    const idle = window.requestIdleCallback(() => setVisited(true), { timeout: 400 });
    return () => window.cancelIdleCallback(idle);
  }, [ready, active, dismissed, visited]);

  const move = useCallback((x: number, y: number) => {
    const button = frame.current;
    const area = layer.current;
    if (!button || !area || !area.clientWidth || !area.clientHeight) return;
    const bounds = area.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    const left = Math.max(
      bounds.left + 16,
      Math.min(bounds.right - rect.width - 16, rect.left + x - offset.current.x),
    );
    const top = Math.max(
      bounds.top + 16,
      Math.min(bounds.bottom - rect.height - 16, rect.top + y - offset.current.y),
    );
    offset.current = {
      x: offset.current.x + left - rect.left,
      y: offset.current.y + top - rect.top,
    };
    button.style.transform = `translate(${offset.current.x}px, ${offset.current.y}px)`;
  }, []);

  const resize = useCallback(
    (requested: number) => {
      const surface = frame.current;
      const area = layer.current;
      if (!surface || !area || !area.clientWidth || !area.clientHeight) return;
      const limit = Math.max(
        0,
        Math.min(maximumWidth, area.clientWidth - 32, (area.clientHeight - 32) * previewRatio),
      );
      const minimum = Math.min(minimumWidth, limit);
      width.current = Math.max(minimum, Math.min(limit, requested));
      surface.style.width = `${width.current}px`;
      // Keep the top-right corner anchored while the bottom-left handle moves.
      move(offset.current.x, offset.current.y);
      resizeHandle.current?.setAttribute("aria-valuemin", String(Math.round(minimum)));
      resizeHandle.current?.setAttribute("aria-valuemax", String(Math.round(limit)));
      resizeHandle.current?.setAttribute("aria-valuenow", String(Math.round(width.current)));
    },
    [move],
  );

  useEffect(() => {
    if (!ready || !active || dismissed || !layer.current) return;
    const observer = new ResizeObserver(() => resize(width.current));
    observer.observe(layer.current);
    return () => observer.disconnect();
  }, [ready, active, dismissed, resize]);

  function beginDrag(event: PointerEvent<HTMLButtonElement>, kind: "move" | "resize") {
    if (event.button !== 0 || !event.isPrimary || drag.current) return;
    suppressClick.current = false;
    drag.current = {
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      ...offset.current,
      width: frame.current?.getBoundingClientRect().width ?? width.current,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function continueDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moved && Math.hypot(dx, dy) < 5) return;
    current.moved = true;
    if (current.kind === "move") {
      if (frame.current) frame.current.dataset.dragging = "true";
      move(current.x + dx, current.y + dy);
    } else {
      if (frame.current) frame.current.dataset.resizing = "true";
      const delta = Math.abs(dx) > Math.abs(dy * previewRatio) ? -dx : dy * previewRatio;
      resize(current.width + delta);
    }
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    suppressClick.current = current.moved || cancelled;
    drag.current = null;
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
    // Do not replace the file under someone's pointer while they are inspecting it.
    if (thread.status === "running" && candidate && !expanded && !dismissed)
      setTargetId(candidate.id);
  }, [thread.status, candidate?.id, expanded, dismissed]);

  useEffect(() => {
    if (!summary || dismissed) return;
    let current = true;
    void api.readDesign(thread.projectId, summary.id).then(
      (design) => {
        if (current) setValue(design);
      },
      () => {
        // Atomic writes can briefly make a design unavailable. Keep its last valid frame.
      },
    );
    return () => {
      current = false;
    };
  }, [api, thread.projectId, summary?.id, summary?.updatedAt, dismissed]);

  const closeImmediately = useCallback(() => {
    generation.current++;
    animations.current.forEach((motion) => motion.cancel());
    animations.current = [];
    dialog.current?.close();
    if (dialog.current) dialog.current.style.clipPath = "";
    if (canvas.current) canvas.current.style.transform = "";
    setPhase("closed");
  }, []);

  useEffect(() => {
    if (!active || !summary) closeImmediately();
  }, [active, summary?.id, closeImmediately]);
  useEffect(() => {
    if (phase === "open")
      dialog.current
        ?.querySelector<HTMLButtonElement>('[aria-label="Minimise canvas"]')
        ?.focus({ preventScroll: true });
    if (phase === "closed" && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus({ preventScroll: true });
    }
  }, [phase]);
  useEffect(
    () => () => {
      generation.current++;
      animations.current.forEach((motion) => motion.cancel());
    },
    [],
  );

  const transition = useCallback((open: boolean) => {
    const surface = dialog.current;
    const button = trigger.current;
    const content = canvas.current;
    if (!surface || !button || !content) return;
    // The editor normally warms during idle time; an immediate click can get there first.
    flushSync(() => setVisited(true));
    const epoch = ++generation.current;
    const rect = button.getBoundingClientRect();
    const corners = getComputedStyle(button).borderTopLeftRadius.split(" ");
    const radius = (value: string, size: number) =>
      parseFloat(value) * (value.endsWith("%") ? size / 100 : 1);
    const compactClip = `inset(${rect.top}px ${surface.clientWidth - rect.right}px ${surface.clientHeight - rect.bottom}px ${rect.left}px round ${radius(corners[0], rect.width)}px / ${radius(corners[1] ?? corners[0], rect.height)}px)`;
    const fullClip = "inset(0px 0px 0px 0px round 0px)";
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
    if (open && !surface.open) surface.showModal();
    flushSync(() => setPhase(open ? "opening" : "closing"));
    const duration = reduced ? 100 : open ? 650 : 450;
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
    const controls = chrome.map((element, index) =>
      element.animate([{ opacity: open ? 0 : chromeOpacity[index] }, { opacity: open ? 1 : 0 }], {
        duration: 100,
        delay: open && !reduced ? duration - 100 : 0,
        fill: "both",
      }),
    );
    const motions = [aperture, artwork, ...controls];
    animations.current = motions;
    void Promise.all([aperture.finished, artwork.finished]).then(
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
      },
      () => {},
    );
  }, []);
  const minimise = useCallback(() => transition(false), [transition]);

  if (dismissed || !summary || !value || value.id !== summary.id) return null;
  return (
    <div
      ref={layer}
      className="thread-design-window"
      data-working={thread.status === "running"}
      hidden={!active}
    >
      <div ref={frame} className="thread-design-frame" data-expanded={expanded}>
        <Button
          ref={trigger}
          type="button"
          className="thread-design-peek"
          aria-label="Expand canvas"
          aria-haspopup="dialog"
          aria-controls={id}
          aria-expanded={expanded}
          aria-description={`Live view of ${value.name}. Drag to move, resize from the bottom-left corner, or click to expand.`}
          data-expanded={expanded}
          onPointerDown={(event) => beginDrag(event, "move")}
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
            if (!direction) return;
            event.preventDefault();
            event.stopPropagation();
            const step = event.shiftKey ? 40 : 16;
            move(offset.current.x + direction[0] * step, offset.current.y + direction[1] * step);
          }}
          onClick={(event) => {
            if (!suppressClick.current || event.detail === 0) transition(true);
            suppressClick.current = false;
          }}
        >
          <span className="thread-design-lens" aria-hidden="true" inert>
            <span className="thread-design-artwork">
              <DocumentPreview content={value.document} assetUrl={(id) => value.assets[id] ?? ""} />
            </span>
          </span>
          <span className="thread-design-rim" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          className="thread-design-close"
          aria-label="Close preview"
          onClick={() => {
            restoreFocus.current = false;
            closeImmediately();
            layer.current?.parentElement
              ?.querySelector<HTMLElement>(".transcript")
              ?.focus({ preventScroll: true });
            setDismissed(true);
          }}
        >
          <Icon name="xmark" size={12} />
        </Button>
        <Button
          ref={resizeHandle}
          type="button"
          className="thread-design-resize"
          role="slider"
          aria-label="Resize preview"
          aria-description="Drag to resize, or use the arrow keys."
          aria-valuemin={minimumWidth}
          aria-valuemax={maximumWidth}
          aria-valuenow={296}
          onPointerDown={(event) => beginDrag(event, "resize")}
          onPointerMove={continueDrag}
          onPointerUp={(event) => finishDrag(event)}
          onPointerCancel={(event) => finishDrag(event, true)}
          onLostPointerCapture={(event) => finishDrag(event, true)}
          onKeyDown={(event) => {
            const direction =
              event.key === "ArrowRight" || event.key === "ArrowUp"
                ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowDown"
                  ? -1
                  : 0;
            if (!direction && event.key !== "Home" && event.key !== "End") return;
            event.preventDefault();
            resize(
              event.key === "Home"
                ? minimumWidth
                : event.key === "End"
                  ? maximumWidth
                  : width.current + direction * (event.shiftKey ? 40 : 16),
            );
          }}
        >
          <svg
            aria-hidden="true"
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
          >
            <path d="m9 9-6-6M5 9 3 7" />
          </svg>
        </Button>
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
          {visited && (
            <LocalCanvas
              key={value.id}
              api={api}
              projectId={thread.projectId}
              initial={value}
              active={phase === "open"}
              initialPanelsOpen={false}
              backLabel="Minimise canvas"
              onBack={minimise}
              onUpdate={update}
            />
          )}
        </div>
      </Dialog>
    </div>
  );
}
