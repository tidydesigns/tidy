import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { DocumentPreview } from "@tidy/editor/components/files/document-preview";
import { gestureZoomFactor } from "@tidy/editor/design/canvas-zoom";
import type { LocalDesign } from "../../../../shared/contracts/desktop";
import {
  fitPreview,
  wheelPreview,
  zoomPreview,
  type PreviewBounds,
  type PreviewCameraMemory,
} from "./preview-navigation";
import { createPreviewPointerGesture } from "./preview-pointer";

export const PreviewCamera = memo(function PreviewCamera({
  value,
  memory,
  surface,
  suppressClick,
  enabled,
}: {
  value: LocalDesign;
  memory: PreviewCameraMemory;
  surface: RefObject<HTMLButtonElement | null>;
  suppressClick: RefObject<boolean>;
  enabled: boolean;
}) {
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1, width: 1, height: 1 });
  const bounds = useRef<PreviewBounds | undefined>(undefined);
  const size = useRef({ width: 0, height: 0 });
  const pending = useRef(0);
  const schedule = useCallback(() => {
    if (pending.current) return;
    pending.current = requestAnimationFrame(() => {
      pending.current = 0;
      if (memory.current) setViewport({ ...memory.current, ...size.current });
    });
  }, [memory]);
  const initialize = useCallback(() => {
    if (!memory.current && bounds.current && size.current.width > 0 && size.current.height > 0)
      memory.current = fitPreview(bounds.current, size.current);
    schedule();
  }, [memory, schedule]);
  const onBounds = useCallback(
    (next: PreviewBounds) => {
      bounds.current = next;
      initialize();
    },
    [initialize],
  );
  const assetURL = useCallback((id: string) => value.assets[id] ?? "", [value.assets]);
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element || !enabled) return;
    const measure = () => {
      size.current = { width: element.clientWidth, height: element.clientHeight };
      initialize();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [surface, enabled, initialize]);
  useEffect(() => {
    const element = surface.current;
    if (!element || !enabled) return;
    let space = false;
    const pointer = createPreviewPointerGesture();
    let gestureScale: number | undefined;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!memory.current || gestureScale !== undefined) return;
      const rect = element.getBoundingClientRect();
      memory.current = wheelPreview(
        memory.current,
        event,
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        size.current.height,
      );
      suppressClick.current = true;
      schedule();
    };
    const key = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      event.preventDefault();
      event.stopPropagation();
      space = event.type === "keydown";
      element.dataset.panning = String(space);
    };
    const blur = () => {
      space = false;
      delete element.dataset.panning;
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary) return;
      element.focus({ preventScroll: true });
      suppressClick.current = pointer.start(event.pointerId, event.clientX, event.clientY, space);
      element.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      const delta = pointer.move(event.pointerId, event.clientX, event.clientY);
      if (!delta) return;
      suppressClick.current = true;
      if (memory.current && (delta.x || delta.y)) {
        memory.current = {
          ...memory.current,
          x: memory.current.x + delta.x,
          y: memory.current.y + delta.y,
        };
        schedule();
      }
    };
    const up = (event: PointerEvent) => {
      const suppress = pointer.finish(event.pointerId, event.type !== "pointerup");
      if (suppress === undefined) return;
      suppressClick.current ||= suppress;
      if (element.hasPointerCapture(event.pointerId))
        element.releasePointerCapture(event.pointerId);
    };
    const gesture = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "gestureend") {
        gestureScale = undefined;
        return;
      }
      if (event.type === "gesturestart") {
        gestureScale = 1;
        return;
      }
      if (
        !("scale" in event) ||
        typeof event.scale !== "number" ||
        !Number.isFinite(event.scale) ||
        event.scale <= 0 ||
        !memory.current
      )
        return;
      const rect = element.getBoundingClientRect();
      const x =
        "clientX" in event && typeof event.clientX === "number"
          ? event.clientX - rect.left
          : rect.width / 2;
      const y =
        "clientY" in event && typeof event.clientY === "number"
          ? event.clientY - rect.top
          : rect.height / 2;
      memory.current = zoomPreview(
        memory.current,
        x,
        y,
        gestureZoomFactor(event.scale, gestureScale ?? 1),
      );
      gestureScale = event.scale;
      suppressClick.current = true;
      schedule();
    };
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("keydown", key);
    element.addEventListener("keyup", key);
    element.addEventListener("blur", blur);
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const)
      element.addEventListener(name, up);
    for (const name of ["gesturestart", "gesturechange", "gestureend"])
      element.addEventListener(name, gesture, { passive: false });
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("keydown", key);
      element.removeEventListener("keyup", key);
      element.removeEventListener("blur", blur);
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const)
        element.removeEventListener(name, up);
      for (const name of ["gesturestart", "gesturechange", "gestureend"])
        element.removeEventListener(name, gesture);
      blur();
    };
  }, [surface, enabled, memory, suppressClick, schedule]);
  useEffect(
    () => () => {
      cancelAnimationFrame(pending.current);
      pending.current = 0;
    },
    [],
  );
  return (
    <DocumentPreview
      content={value.document}
      assetUrl={assetURL}
      viewport={viewport}
      onBounds={onBounds}
    />
  );
});
