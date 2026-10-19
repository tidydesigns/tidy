"use client";
import { useId, useRef, useState, type ReactNode } from "react";
import { SelectMenu } from "../components/ui/select-menu";
import type { DesignNode, DesignNodeChanges } from "../design/document";
import { normalizeColor } from "../design/selection-colors";
import { useCanvasColorPicker } from "./canvas-color-picker";
import { PropertyField } from "./property-field";
type Value = string | number | undefined;
type ColorUpdate = string | ((current: string) => string);
export const applyColor = (value: ColorUpdate, current: string) =>
  typeof value === "function" ? value(current) : value;
export type Patch = DesignNodeChanges | ((node: DesignNode) => DesignNodeChanges);

export function shared<T>(nodes: DesignNode[], get: (node: DesignNode) => T): T | undefined {
  const first = get(nodes[0]);
  return nodes.every((node) => JSON.stringify(get(node)) === JSON.stringify(first))
    ? first
    : undefined;
}

export function Choice<const T extends string>({
  label,
  replayLabel = false,
  replayOptions = false,
  value,
  choices,
  onChange,
}: {
  label: string;
  replayLabel?: boolean;
  replayOptions?: boolean;
  value: Value;
  choices: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  const labelId = useId();
  return (
    <div className="min-w-0 text-[10px] text-secondary-ink">
      <span id={labelId} data-ph-public={replayLabel || undefined}>
        {label}
      </span>
      <SelectMenu
        replayLabel={replayLabel}
        replayOptions={replayOptions}
        label={label}
        labelledBy={labelId}
        size="sm"
        className="mt-1"
        value={value === undefined ? "__mixed" : String(value)}
        onChange={(value) => {
          const option = choices.find(([key]) => key === value);
          if (option) onChange(option[0]);
        }}
        options={[
          ...(value === undefined ? [{ value: "__mixed", label: "Mixed", disabled: true }] : []),
          ...choices.map(([value, label]) => ({ value, label })),
        ]}
      />
    </div>
  );
}

export function Section({
  title,
  replayTitle = false,
  action,
  children,
}: {
  title: string;
  replayTitle?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 border-b border-primary-grey/60 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h3 data-ph-public={replayTitle || undefined} className="text-xs font-medium">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ColorField({
  label,
  compact = false,
  replayLabel = false,
  nodes,
  get,
  onChange,
}: {
  label: string;
  compact?: boolean;
  replayLabel?: boolean;
  nodes: DesignNode[];
  get: (node: DesignNode) => string;
  onChange: (color: ColorUpdate) => void;
}) {
  const [open, setOpen] = useState(false);
  const sampler = useCanvasColorPicker();
  const swatch = useRef<HTMLButtonElement>(null);
  const color = shared(nodes, get);
  const alpha = shared(nodes, (node) => {
    const value = get(node);
    return Math.round((value.length === 9 ? parseInt(value.slice(7), 16) / 255 : 1) * 100);
  });
  return (
    <div className="space-y-1.5">
      <div className={compact ? "grid grid-cols-[64px_minmax(0,1fr)] items-center gap-3" : ""}>
        {compact && <span className="text-xs text-secondary-ink">Value</span>}
        <div
          className={
            compact
              ? "grid grid-cols-[20px_minmax(0,1fr)_64px] items-center gap-1 rounded-md border border-control-border bg-surface px-2"
              : "grid grid-cols-[32px_1fr_64px] items-end gap-1.5"
          }
        >
          <button
            ref={swatch}
            data-ph-private
            type="button"
            aria-label={`Open ${label.toLowerCase()} palette`}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className={`${compact ? "h-5 w-5" : "h-8 w-8"} rounded border border-primary-grey/70 focus-visible:outline-2 focus-visible:outline-primary-orange`}
            style={{ backgroundColor: color ?? "#ffffff" }}
          />
          <PropertyField
            replayLabel={replayLabel}
            label={label}
            layout={compact ? "embedded" : "stacked"}
            value={color}
            validate={(value) =>
              normalizeColor(value) ? undefined : "Enter a hex color such as #336699 or #336699ff."
            }
            onCommit={onChange}
          />
          <div className={compact ? "flex items-center text-xs text-secondary-ink" : ""}>
            <PropertyField
              replayLabel={replayLabel}
              layout={compact ? "embedded" : "stacked"}
              label={`${label} alpha %`}
              value={alpha}
              numeric
              min={0}
              max={100}
              onCommit={(value) => {
                if (value === "") return;
                onChange(
                  (current) =>
                    current.slice(0, 7) +
                    Math.round((Number(value) / 100) * 255)
                      .toString(16)
                      .padStart(2, "0"),
                );
              }}
            />
            {compact && <span aria-hidden="true">%</span>}
          </div>
        </div>
      </div>
      {open && (
        <div className="space-y-2 rounded-md border border-primary-grey/70 bg-surface p-2 text-[10px]">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1">
              <span data-ph-public style={{ display: "contents" }}>
                Color picker
              </span>
              <input
                aria-label={`Choose ${label.toLowerCase()}`}
                type="color"
                value={color?.slice(0, 7) ?? "#000000"}
                onChange={(event) => {
                  const rgb = event.target.value;
                  onChange((current) => rgb + (current.length === 9 ? current.slice(7) : ""));
                }}
                className="h-7 w-8 cursor-pointer rounded border border-primary-grey/70 bg-surface p-0.5"
              />
            </label>
            {sampler && (
              <button
                data-ph-public
                type="button"
                onClick={() => {
                  setOpen(false);
                  sampler.pick(onChange, swatch.current);
                }}
                className="rounded border border-primary-grey/70 px-2 py-1 hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange"
              >
                Pick from canvas
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
