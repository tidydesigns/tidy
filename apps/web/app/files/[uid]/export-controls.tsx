"use client";
import { useState } from "react";
import type { DesignNode } from "@/lib/design/document";
import type { ExportRequest, ExportFormat } from "@/lib/design/export-plan";
import { PropertyField } from "./property-field";
import { Choice, Section } from "./inspector-controls";
const button =
  "rounded-md border border-primary-grey/70 px-2 py-1.5 text-xs hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange disabled:opacity-40";
export function ExportControls({
  selected,
  onExport,
  pending = false,
  warnings = [],
}: {
  selected: DesignNode[];
  onExport: (request: ExportRequest) => void;
  pending?: boolean;
  warnings?: string[];
}) {
  const [scale, setScale] = useState(1),
    [mode, setMode] = useState<ExportRequest["mode"]>("selection");
  return (
    <Section title="Export">
      <div className="space-y-2">
        {selected.length > 1 && (
          <Choice
            label="Export mode"
            value={mode}
            choices={[
              ["selection", "Selection"],
              ["batch", "Batch"],
            ]}
            onChange={(v) => setMode(v as ExportRequest["mode"])}
          />
        )}
        <PropertyField
          label="Export scale"
          value={scale}
          numeric
          min={0.25}
          max={4}
          step={0.25}
          onCommit={(v) => setScale(Number(v))}
        />
        <div className="flex flex-wrap gap-1.5">
          {(["png", "svg", "webp", "pdf"] as ExportFormat[]).map((format) => (
            <button
              key={format}
              type="button"
              disabled={pending}
              className={`${button} uppercase`}
              onClick={() =>
                onExport({
                  ids: selected.map((n) => n.id),
                  scale,
                  mode: selected.length > 1 ? mode : "selection",
                  format,
                })
              }
            >
              {format}
            </button>
          ))}
        </div>
        {pending && (
          <p role="status" className="text-xs text-secondary-ink">
            Preparing export…
          </p>
        )}
        {warnings.length > 0 && (
          <details className="text-xs text-secondary-ink">
            <summary className="cursor-pointer">SVG rendering details · {warnings.length}</summary>
            <ul className="mt-1 max-h-24 overflow-auto">
              {warnings.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Section>
  );
}
