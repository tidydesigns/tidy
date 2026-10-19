"use client";
import { useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { SelectMenu } from "../components/ui/select-menu";
import type { DesignNode, DesignNodeChanges } from "../design/document";
import { addRecentColor, normalizeColor, selectionColors } from "../design/selection-colors";
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

const recentKey = "bella-recent-colors";
const recentEvent = "bella-recent-colors-changed";
function recentSnapshot() {
  try {
    return localStorage.getItem(recentKey) ?? "[]";
  } catch {
    return "[]";
  }
}
function subscribeRecent(listener: () => void) {
  window.addEventListener(recentEvent, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(recentEvent, listener);
    window.removeEventListener("storage", listener);
  };
}
const emptyRecentSnapshot = () => "[]";
const noSubscription = () => () => {};
const sampleAvailable = () => "EyeDropper" in window;
const sampleUnavailable = () => false;
function readRecentColors(snapshot: string): string[] {
  try {
    const stored: unknown = JSON.parse(snapshot);
    return Array.isArray(stored)
      ? stored
          .filter(
            (color): color is string => typeof color === "string" && Boolean(normalizeColor(color)),
          )
          .slice(0, 12)
      : [];
  } catch {
    return [];
  }
}

export function ColorField({
  label,
  compact = false,
  replayLabel = false,
  nodes,
  get,
  onChange,
  tokens = {},
}: {
  label: string;
  compact?: boolean;
  replayLabel?: boolean;
  nodes: DesignNode[];
  get: (node: DesignNode) => string;
  onChange: (color: ColorUpdate) => void;
  tokens?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const recentJson = useSyncExternalStore(subscribeRecent, recentSnapshot, emptyRecentSnapshot);
  const recent = useMemo(() => readRecentColors(recentJson), [recentJson]);
  const canSample = useSyncExternalStore(noSubscription, sampleAvailable, sampleUnavailable);
  const color = shared(nodes, get);
  const alpha = shared(nodes, (node) => {
    const value = get(node);
    return Math.round((value.length === 9 ? parseInt(value.slice(7), 16) / 255 : 1) * 100);
  });
  const palette = selectionColors(nodes, tokens);
  function change(value: ColorUpdate) {
    const next = applyColor(value, color ?? get(nodes[0]));
    onChange(value);
    const updated = addRecentColor(readRecentColors(recentSnapshot()), next);
    try {
      localStorage.setItem(recentKey, JSON.stringify(updated));
      window.dispatchEvent(new Event(recentEvent));
    } catch {
      /* Color edits still apply if storage is unavailable. */
    }
  }
  async function sample() {
    const constructor = (
      window as Window & { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }
    ).EyeDropper;
    if (!constructor) return;
    try {
      const { sRGBHex } = await new constructor().open();
      if (normalizeColor(sRGBHex)) {
        change((current) => sRGBHex + (current.length === 9 ? current.slice(7) : ""));
        setOpen(false);
      }
    } catch {
      /* Escape cancels sampling. */
    }
  }
  const swatches = (colors: string[], group: string) => (
    <div className="flex flex-wrap gap-1">
      {colors.map((value) => (
        <button
          data-ph-private
          key={value}
          type="button"
          aria-label={`Use ${group} color ${value}`}
          title={value}
          onClick={() => {
            change(value);
            setOpen(false);
          }}
          className="h-6 w-6 rounded border border-primary-grey/70 focus-visible:outline-2 focus-visible:outline-primary-orange"
          style={{ backgroundColor: value }}
        />
      ))}
    </div>
  );
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
            onCommit={change}
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
                change(
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
                  change((current) => rgb + (current.length === 9 ? current.slice(7) : ""));
                }}
                className="h-7 w-8 cursor-pointer rounded border border-primary-grey/70 bg-surface p-0.5"
              />
            </label>
            {canSample && (
              <button
                data-ph-public
                type="button"
                onClick={sample}
                className="rounded border border-primary-grey/70 px-2 py-1 hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange"
              >
                Sample canvas
              </button>
            )}
          </div>
          {palette.length > 0 && (
            <div className="space-y-1">
              <span data-ph-public className="text-secondary-ink">
                Selection
              </span>
              {swatches(palette, "selection")}
            </div>
          )}
          {recent.length > 0 && (
            <div className="space-y-1">
              <span data-ph-public className="text-secondary-ink">
                Recent
              </span>
              {swatches(recent, "recent")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
