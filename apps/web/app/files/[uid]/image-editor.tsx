"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  hasImageAdjustments,
  imageAdjustmentFilter,
  imageAdjustmentLabels,
  type ImageAdjustments,
  type ImageAdjustment,
} from "@bella/design/image-adjustments";
import type { DesignNode } from "@/lib/design/document";
import type { ImageEdit } from "@/lib/design/image-edit-target";
import { DesignImage } from "@/components/design/design-image";
import { SelectMenu } from "@/components/ui/select-menu";
import { Icon } from "@/components/ui/icon";

const keys = Object.keys(imageAdjustmentLabels) as ImageAdjustment[];
const reset = Object.fromEntries(keys.map((key) => [key, 0])) as ImageAdjustments;
const button =
  "rounded-md px-2 py-1.5 text-xs hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-primary-orange active:scale-[0.97] disabled:opacity-35";

/** Preview only the targeted image's filter. Never render/diff the document on pointer moves. */
function paintPreview(element: Element | null, value?: ImageAdjustments) {
  if (!element) return;
  const id = element.getAttribute("data-adjustable-image")!;
  const document = element.ownerDocument;
  const adjustments = value ?? JSON.parse(element.getAttribute("data-image-adjustments") || "{}");
  const adjusted = hasImageAdjustments(adjustments);
  let definitions: Element | null | undefined = document.getElementById(id)?.parentElement;
  if (!definitions && adjusted) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("data-image-preview-filter", "");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;width:0;height:0;pointer-events:none";
    definitions = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.appendChild(definitions);
    element.parentElement?.appendChild(svg);
  }
  if (definitions) {
    if (!adjusted && definitions.parentElement?.hasAttribute("data-image-preview-filter"))
      definitions.parentElement.remove();
    else definitions.innerHTML = imageAdjustmentFilter(id, adjustments);
  }
  const pixels =
    element.querySelector<SVGElement>("[data-adjustment-pixels]") ?? (element as HTMLElement);
  pixels.style.filter = hasImageAdjustments(adjustments) ? `url(#${id})` : "";
}

export function ImageEditor({
  node,
  source,
  onEdit,
  onClose,
  onCrop,
  getImage,
  right = 16,
}: {
  node: DesignNode;
  source: string;
  onEdit: (edit: ImageEdit) => void;
  onClose: () => void;
  onCrop?: () => void;
  getImage: () => Element | null;
  right?: number;
}) {
  const [draft, setDraft] = useState<ImageAdjustments | null>(null);
  const values = { ...node.style.imageAdjustments, ...draft };
  const canvasImage = getImage();
  const loadedSource =
    canvasImage?.hasAttribute("data-image-loading") ||
    canvasImage?.hasAttribute("data-image-failed")
      ? undefined
      : canvasImage instanceof HTMLImageElement
        ? canvasImage.currentSrc
        : canvasImage?.querySelector("image")?.getAttribute("href");
  const previewScale = Math.min(270 / node.box.width, 174 / node.box.height);
  const gesture = useRef<{ key: ImageAdjustment; value: number; element: Element | null } | null>(
    null,
  );
  const frame = useRef<number | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  const latest = useRef({ values, onEdit });
  useLayoutEffect(() => {
    latest.current = { values, onEdit };
  });
  useEffect(() => {
    const previous = document.activeElement;
    close.current?.focus({ preventScroll: true });
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      paintPreview(gesture.current?.element ?? null);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);
  function cancel() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    paintPreview(gesture.current?.element ?? null);
    gesture.current = null;
    setDraft(null);
  }
  function preview(key: ImageAdjustment, value: number) {
    gesture.current ??= { key, value, element: getImage() };
    gesture.current.value = value;
    setDraft({ [key]: value });
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (gesture.current)
        paintPreview(gesture.current.element, { ...latest.current.values, [key]: value });
    });
  }
  function commit() {
    const current = gesture.current;
    if (!current) return;
    cancel();
    onEdit({ adjustments: { [current.key]: current.value } });
  }
  return (
    <section
      role="dialog"
      aria-label="Image editor"
      className="image-editor absolute top-16 z-40 w-[304px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-xl border border-primary-grey/70 bg-surface text-primary-black"
      style={{
        right: `clamp(16px, calc(100vw - 336px), ${right}px)`,
        maxHeight: "calc(100dvh - 96px)",
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          if (gesture.current) cancel();
          else onClose();
        }
      }}
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-3">
        <span className="text-xs font-medium">Image</span>
        <button
          ref={close}
          type="button"
          aria-label="Close image editor"
          className={`${button} text-secondary-ink`}
          onClick={onClose}
        >
          <Icon name="xmark" size={14} />
        </button>
      </div>
      <div className="px-4 pb-4">
        <div className="mb-3 flex items-center gap-2">
          <SelectMenu
            label="Image placement"
            size="sm"
            className="flex-1"
            value={node.style.objectFit ?? "cover"}
            options={[
              { value: "cover", label: "Fill" },
              { value: "contain", label: "Fit" },
              { value: "fill", label: "Stretch" },
            ]}
            onChange={(fit) => onEdit({ fit: fit as ImageEdit["fit"] })}
          />
          {onCrop && (
            <button
              type="button"
              className={button}
              onClick={() => {
                onClose();
                onCrop();
              }}
            >
              Crop
            </button>
          )}
        </div>
        <div className="image-editor-preview relative mb-3 flex h-44 items-center justify-center overflow-hidden rounded-lg border border-primary-grey/50">
          <div
            style={{
              position: "relative",
              width: node.box.width * previewScale,
              height: node.box.height * previewScale,
              overflow: "hidden",
            }}
          >
            <DesignImage
              node={{
                ...node,
                name: "Image preview",
                style: { ...node.style, imageAdjustments: values, radius: undefined },
                box: {
                  ...node.box,
                  width: node.box.width * previewScale,
                  height: node.box.height * previewScale,
                },
              }}
              src={loadedSource || source}
            />
          </div>
        </div>
        <div className="space-y-0.5">
          {keys.map((key) => (
            <AdjustmentControl
              key={key}
              name={key}
              value={Math.round((values[key] ?? 0) * 100)}
              onPreview={(value) => preview(key, value / 100)}
              onCommit={commit}
              onCancel={cancel}
              onValue={(value) => onEdit({ adjustments: { [key]: value / 100 } })}
            />
          ))}
        </div>
        <div className="mt-2 flex justify-end pt-2">
          <button
            type="button"
            className={button}
            disabled={!hasImageAdjustments(values)}
            onClick={() => {
              cancel();
              onEdit({ adjustments: reset });
            }}
          >
            Reset adjustments
          </button>
        </div>
      </div>
    </section>
  );
}

function AdjustmentControl({
  name,
  value,
  onPreview,
  onCommit,
  onCancel,
  onValue,
}: {
  name: ImageAdjustment;
  value: number;
  onPreview: (value: number) => void;
  onCommit: () => void;
  onCancel: () => void;
  onValue: (value: number) => void;
}) {
  const label = imageAdjustmentLabels[name];
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  return (
    <div className="grid h-9 grid-cols-[88px_1fr_36px] items-center gap-2">
      <label htmlFor={`image-${name}`} className="text-xs text-secondary-ink">
        {label}
      </label>
      <input
        id={`image-${name}`}
        aria-label={label}
        type="range"
        min={-100}
        max={100}
        step={1}
        value={value}
        className="image-adjustment-slider"
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onChange={(event) => onPreview(Number(event.target.value))}
        onPointerUp={onCommit}
        onPointerCancel={onCancel}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        onKeyUp={(event) => {
          if (
            [
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Home",
              "End",
              "PageUp",
              "PageDown",
            ].includes(event.key)
          )
            onCommit();
        }}
      />
      <input
        aria-label={`${label} value`}
        inputMode="numeric"
        className="image-adjustment-value h-6 w-9 rounded-md bg-panel text-center text-[11px] tabular-nums outline-none hover:bg-hover-surface focus:bg-hover-surface focus:ring-1 focus:ring-primary-orange"
        value={draft ?? value}
        onChange={(event) => {
          cancelled.current = false;
          setDraft(event.target.value);
        }}
        onBlur={() => {
          if (
            !cancelled.current &&
            draft !== null &&
            draft.trim() !== "" &&
            Number.isFinite(Number(draft))
          )
            onValue(Math.max(-100, Math.min(100, Number(draft))));
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.stopPropagation();
            cancelled.current = true;
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
