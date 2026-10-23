import { useCallback, useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { Button } from "@tidy/ui/button";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import { DocumentPreview } from "@tidy/editor/components/files/document-preview";
import { Icon } from "@tidy/editor/components/ui/icon";
import { threadDesign } from "../../shared/thread-design";
import type { DesktopAPI, DesignSummary, LocalDesign, Thread } from "../../shared/contracts";
import { LocalCanvas } from "./local-canvas";

type Phase = "closed" | "opening" | "open" | "closing";
const easing = "cubic-bezier(0.32, 0.72, 0, 1)";
const previewRatio = 1.5;
const minimumWidth = 220;
const maximumWidth = 560;

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
  const animation = useRef<Animation | null>(null);
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
    animation.current?.cancel();
    animation.current = null;
    dialog.current?.close();
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
      animation.current?.cancel();
    },
    [],
  );

  const transition = useCallback((open: boolean) => {
    const surface = dialog.current;
    const button = trigger.current;
    if (!surface || !button) return;
    const epoch = ++generation.current;
    const rect = button.getBoundingClientRect();
    const compact = `translate(${rect.left}px, ${rect.top}px) scale(${rect.width / window.innerWidth}, ${rect.height / window.innerHeight})`;
    const radius = getComputedStyle(button).borderRadius;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const previous = surface.open
      ? {
          transform: getComputedStyle(surface).transform,
          borderRadius: getComputedStyle(surface).borderRadius,
        }
      : { transform: compact, borderRadius: radius };
    animation.current?.cancel();
    if (open && !surface.open) surface.showModal();
    setPhase(open ? "opening" : "closing");
    if (open) setVisited(true);
    const motion = surface.animate(
      [
        reduced ? { opacity: open ? 0 : 1 } : previous,
        reduced
          ? { opacity: open ? 1 : 0 }
          : { transform: open ? "none" : compact, borderRadius: open ? "0%" : radius },
      ],
      { duration: reduced ? 100 : 280, easing, fill: "both" },
    );
    animation.current = motion;
    void motion.finished.then(
      () => {
        if (generation.current !== epoch) return;
        if (open) {
          setPhase("open");
        } else {
          restoreFocus.current = true;
          surface.close();
          setPhase("closed");
        }
        motion.cancel();
        animation.current = null;
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
        <div className="thread-design-canvas" inert={phase !== "open"}>
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
        <div className="thread-design-transition-artwork" aria-hidden="true" inert>
          <DocumentPreview content={value.document} assetUrl={(id) => value.assets[id] ?? ""} />
        </div>
      </Dialog>
    </div>
  );
}
