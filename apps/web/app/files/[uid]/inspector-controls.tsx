"use client";
import { useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { SelectMenu } from "@/components/ui/select-menu";
import type { DesignNode, DesignNodeChanges } from "@/lib/design/document";
import { addRecentColor, normalizeColor, selectionColors } from "@/lib/design/selection-colors";
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

export function Choice({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: Value;
  choices: [string, string][];
  onChange: (value: string) => void;
}) {
  const labelId = useId();
  return (
    <div className="min-w-0 text-[10px] text-secondary-ink">
      <span id={labelId}>{label}</span>
      <SelectMenu
        label={label}
        labelledBy={labelId}
        size="sm"
        className="mt-1"
        value={value === undefined ? "__mixed" : String(value)}
        onChange={onChange}
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
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 border-b border-primary-grey/60 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium">{title}</h3>
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
  nodes,
  get,
  onChange,
  tokens = {},
}: {
  label: string;
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
      <div className="grid grid-cols-[32px_1fr_64px] items-end gap-1.5">
        <button
          type="button"
          aria-label={`Open ${label.toLowerCase()} palette`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="h-8 w-8 rounded border border-primary-grey/70 focus-visible:outline-2 focus-visible:outline-primary-orange"
          style={{ backgroundColor: color ?? "#ffffff" }}
        />
        <PropertyField
          label={label}
          value={color}
          validate={(value) => Boolean(normalizeColor(value))}
          onCommit={change}
        />
        <PropertyField
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
      </div>
      {open && (
        <div className="space-y-2 rounded-md border border-primary-grey/70 bg-surface p-2 text-[10px]">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1">
              Color picker
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
              <span className="text-secondary-ink">Selection</span>
              {swatches(palette, "selection")}
            </div>
          )}
          {recent.length > 0 && (
            <div className="space-y-1">
              <span className="text-secondary-ink">Recent</span>
              {swatches(recent, "recent")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
