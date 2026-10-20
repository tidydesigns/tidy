"use client";

import {
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Icon } from "../components/ui/icon";
import { useCanvasColorPicker } from "./canvas-color-picker";
import { clamp, hexToHsva, hsvaToHex, type Hsva } from "./color-values";
import { PropertyField } from "./property-field";
import { normalizeColor } from "../design/selection-colors";
import { InspectorGesture } from "./inspector-presentation";
import { useEditorEvent } from "./use-editor-event";
import { useFrameEvent } from "./use-frame-event";

const checker = {
  backgroundImage: "conic-gradient(#8883 25%, transparent 0 50%, #8883 0 75%, transparent 0)",
  backgroundSize: "8px 8px",
};
const action =
  "flex h-7 w-7 items-center justify-center rounded-md text-secondary-ink hover:bg-hover-surface hover:text-primary-black focus-visible:outline-2 focus-visible:outline-primary-orange";

export function ColorPickerPopover({
  anchor,
  color,
  onChange,
  onClose,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  color: string;
  onChange: (color: string) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const sampler = useCanvasColorPicker();
  const session = useContext(InspectorGesture);
  const gesture = useRef<{
    pointerId: number;
    apply: typeof onChange;
    next: Hsva;
    applied: string;
    bounds: DOMRect | null;
  } | null>(null);
  const [previous] = useState(color);
  const [state, setState] = useState(() => ({ color, hsv: hexToHsva(color) }));
  let hsv = state.hsv;
  if (state.color !== color) {
    const next = hexToHsva(color);
    if (next.s === 0) next.h = state.hsv.h;
    hsv = next;
    setState({ color, hsv: next });
  }
  const apply = useEditorEvent((next: Hsva) => {
    const active = gesture.current;
    if (active && session && !session.isActive()) return;
    const hex = hsvaToHex(next);
    setState({ color, hsv: next });
    if (active) {
      if (!session || active.applied === hex) return;
      active.applied = hex;
      active.apply(hex);
    } else if (hex !== color) onChange(hex);
  });
  const preview = useFrameEvent(apply);
  function change(next: Hsva) {
    if (gesture.current) {
      gesture.current.next = next;
      preview.schedule(next);
    } else apply(next);
  }
  function begin(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || gesture.current) return;
    session?.begin();
    gesture.current = {
      pointerId: event.pointerId,
      apply: onChange,
      next: hsv,
      applied: color,
      bounds: event.currentTarget.getBoundingClientRect(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function commit(event: ReactPointerEvent<HTMLElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    preview.cancel();
    if (!session) gesture.current = null;
    apply(active.next);
    gesture.current = null;
    session?.commit();
  }
  const cancel = useEditorEvent(() => {
    preview.cancel();
    if (!gesture.current) return;
    gesture.current = null;
    setState({ color, hsv: hexToHsva(color) });
    session?.cancel();
  });
  useLayoutEffect(() => cancel, [cancel]);
  const latest = useRef(onClose);
  useLayoutEffect(() => {
    latest.current = onClose;
  });
  useLayoutEffect(() => {
    const popup = panel.current;
    if (!popup) return;
    popup.showPopover();
    popup.focus({ preventScroll: true });
    function position() {
      if (gesture.current) gesture.current.bounds = null;
      const bounds = anchor.current?.getBoundingClientRect();
      if (!bounds || !popup) return;
      const width = popup.offsetWidth,
        height = popup.offsetHeight;
      const left = bounds.left - width - 12;
      popup.style.left = `${Math.max(12, Math.min(left >= 12 ? left : bounds.right + 12, window.innerWidth - width - 12))}px`;
      popup.style.top = `${Math.max(12, Math.min(bounds.top - 12, window.innerHeight - height - 12))}px`;
    }
    position();
    const observer = new ResizeObserver(position);
    observer.observe(popup);
    document.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    function dismiss(event: PointerEvent) {
      if (
        !(event.target instanceof Node) ||
        popup?.contains(event.target) ||
        anchor.current?.contains(event.target)
      )
        return;
      if (document.activeElement instanceof HTMLElement && popup?.contains(document.activeElement))
        document.activeElement.blur();
      latest.current();
    }
    document.addEventListener("pointerdown", dismiss, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
      document.removeEventListener("pointerdown", dismiss, true);
      if (popup.matches(":popover-open")) popup.hidePopover();
    };
  }, [anchor]);
  function close() {
    anchor.current?.focus({ preventScroll: true });
    onClose();
  }
  return (
    <div
      ref={panel}
      popover="manual"
      role="dialog"
      aria-label="Colour picker"
      tabIndex={-1}
      onPointerUp={commit}
      onLostPointerCapture={commit}
      onPointerCancel={cancel}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape") {
          if (event.target instanceof HTMLInputElement && event.target.type !== "range") return;
          event.preventDefault();
          event.stopPropagation();
          cancel();
          close();
        }
      }}
      className="fixed m-0 w-[288px] max-w-[calc(100vw-24px)] max-h-[calc(100dvh-24px)] overflow-y-auto rounded-xl border border-primary-grey/70 bg-surface text-primary-black shadow-xl outline-none"
    >
      <header className="flex h-11 items-center gap-1 border-b border-primary-grey/50 px-3">
        <span className="flex-1 text-xs font-medium">
          Colour <span className="ml-1.5 text-[10px] font-normal text-secondary-ink">sRGB</span>
        </span>
        {sampler && (
          <button
            type="button"
            aria-label="Pick from canvas"
            title="Pick from canvas"
            className={action}
            onClick={() => {
              onClose();
              sampler.pick(onChange, anchor.current);
            }}
          >
            <Icon name="eyedropper" size={16} />
          </button>
        )}
        <button
          type="button"
          aria-label="Close colour picker"
          title="Close"
          className={action}
          onClick={close}
        >
          <Icon name="xmark" size={14} />
        </button>
      </header>
      <div className="space-y-4 p-3">
        <div
          role="group"
          aria-label="Saturation and brightness"
          className="relative h-44 touch-none rounded-md"
          style={{
            backgroundColor: `hsl(${hsv.h} 100% 50%)`,
            backgroundImage:
              "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            begin(event);
            const bounds = gesture.current?.bounds;
            if (!bounds) return;
            change({
              ...hsv,
              s: clamp((event.clientX - bounds.left) / bounds.width),
              v: 1 - clamp((event.clientY - bounds.top) / bounds.height),
            });
          }}
          onPointerMove={(event) => {
            const active = gesture.current;
            if (!active || active.pointerId !== event.pointerId) return;
            const bounds = (active.bounds ??= event.currentTarget.getBoundingClientRect());
            change({
              ...hsv,
              s: clamp((event.clientX - bounds.left) / bounds.width),
              v: 1 - clamp((event.clientY - bounds.top) / bounds.height),
            });
          }}
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_#0005]"
            style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
          />
        </div>
        <div className="flex items-center gap-3">
          <div
            className="flex h-9 w-14 shrink-0 overflow-hidden rounded-md border border-primary-grey/70"
            style={checker}
          >
            <button
              type="button"
              className="h-full flex-1 focus-visible:outline-2 focus-visible:outline-primary-orange"
              aria-label="Restore previous colour"
              title="Restore previous colour"
              style={{ backgroundColor: previous }}
              onClick={() => onChange(previous)}
            />
            <span
              aria-label="New colour"
              title="New colour"
              className="h-full flex-1"
              style={{ backgroundColor: color }}
            />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <input
              aria-label="Hue"
              type="range"
              min={0}
              max={359.9}
              step={0.1}
              value={hsv.h}
              onPointerDown={begin}
              onChange={(event) => change({ ...hsv, h: Number(event.target.value) })}
              className="color-picker-slider"
              style={{
                background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
              }}
            />
            <div className="rounded-full" style={checker}>
              <input
                aria-label="Opacity"
                type="range"
                min={0}
                max={100}
                value={Math.round(hsv.a * 100)}
                onPointerDown={begin}
                onChange={(event) => change({ ...hsv, a: Number(event.target.value) / 100 })}
                className="color-picker-slider"
                style={{
                  background: `linear-gradient(to right, transparent, ${color.slice(0, 7)})`,
                }}
              />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_64px] gap-2">
          <PropertyField
            label="Hex colour"
            value={color.slice(0, 7).toUpperCase()}
            validate={(value) =>
              normalizeColor(value.startsWith("#") ? value : `#${value}`)
                ? undefined
                : "Enter a six-digit hex colour."
            }
            onCommit={(value) => {
              const next = normalizeColor(value.startsWith("#") ? value : `#${value}`);
              if (next)
                onChange(next.slice(0, 7) + (next.length === 9 ? next.slice(7) : color.slice(7)));
            }}
          />
          <PropertyField
            label="Opacity %"
            displayLabel="%"
            numeric
            min={0}
            max={100}
            value={Math.round(hsv.a * 100)}
            onCommit={(value) => {
              if (value !== "") change({ ...hsv, a: Number(value) / 100 });
            }}
          />
        </div>
        <div className="grid grid-cols-3 gap-2">
          {(["R", "G", "B"] as const).map((label, index) => (
            <PropertyField
              key={label}
              label={label}
              numeric
              min={0}
              max={255}
              value={parseInt(color.slice(1 + index * 2, 3 + index * 2), 16)}
              onCommit={(value) => {
                if (value === "") return;
                const offset = 1 + index * 2;
                onChange(
                  color.slice(0, offset) +
                    Math.round(clamp(Number(value), 255))
                      .toString(16)
                      .padStart(2, "0") +
                    color.slice(offset + 2),
                );
              }}
            />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <PropertyField
            label="Saturation %"
            displayLabel="Sat"
            numeric
            min={0}
            max={100}
            value={Math.round(hsv.s * 100)}
            onCommit={(value) => {
              if (value !== "") change({ ...hsv, s: Number(value) / 100 });
            }}
          />
          <PropertyField
            label="Brightness %"
            displayLabel="Bright"
            numeric
            min={0}
            max={100}
            value={Math.round(hsv.v * 100)}
            onCommit={(value) => {
              if (value !== "") change({ ...hsv, v: Number(value) / 100 });
            }}
          />
        </div>
      </div>
      <style>{`.color-picker-slider{display:block;appearance:none;width:100%;height:10px;border-radius:999px;cursor:pointer}.color-picker-slider::-webkit-slider-thumb{appearance:none;width:12px;height:12px;border:2px solid white;border-radius:50%;background:transparent;box-shadow:0 0 0 1px #0005}.color-picker-slider::-moz-range-thumb{width:9px;height:9px;border:2px solid white;border-radius:50%;background:transparent;box-shadow:0 0 0 1px #0005}.color-picker-slider:focus-visible{outline:2px solid var(--color-primary-orange);outline-offset:3px}`}</style>
    </div>
  );
}
