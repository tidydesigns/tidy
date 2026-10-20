"use client";
import type { DesignNode } from "../../design/document";
import type { SelectionInspectorProps } from "./types";
import { inspectorButtonClass as buttonClass } from "./fields";
import { Choice } from "../inspector-controls";
import { PropertyField } from "../property-field";
type GridTrack = NonNullable<DesignNode["gridColumnTracks"]>[number];
function columnTracks(node: DesignNode): GridTrack[] {
  return (
    node.gridColumnTracks ??
    Array.from({ length: node.gridColumns ?? 2 }, (): GridTrack => ({ unit: "fr", value: 1 }))
  );
}
function updateTrack(node: DesignNode, axis: "column" | "row", index: number, track: GridTrack) {
  const key = axis === "column" ? "gridColumnTracks" : "gridRowTracks";
  const tracks = axis === "column" ? columnTracks(node) : (node.gridRowTracks ?? []);
  return { [key]: tracks.map((item, position) => (position === index ? track : item)) };
}

export function GridTracks({
  node,
  onPatch,
}: Pick<SelectionInspectorProps, "onPatch"> & { node: DesignNode }) {
  return (
    <details className="rounded-md border border-primary-grey/70 px-2 py-1.5 text-xs">
      <summary data-ph-public className="cursor-pointer">
        Grid tracks
      </summary>
      <div className="mt-2 space-y-2">
        {columnTracks(node).map((track, index) => (
          <div key={`column-${index}`} className="grid grid-cols-2 items-end gap-1.5">
            <Choice
              replayOptions
              replayLabel
              label={`Column ${index + 1} unit`}
              value={track.unit}
              choices={[
                ["fr", "Fraction"],
                ["px", "Pixels"],
                ["auto", "Auto"],
              ]}
              onChange={(unit) =>
                onPatch((item) =>
                  updateTrack(
                    item,
                    "column",
                    index,
                    unit === "auto"
                      ? { unit: "auto" }
                      : {
                          unit: unit,
                          value: unit === "fr" ? 1 : 100,
                        },
                  ),
                )
              }
            />
            {track.unit !== "auto" && (
              <PropertyField
                replayLabel
                label={`Column ${index + 1} size`}
                value={track.value}
                numeric
                min={track.unit === "fr" ? 0.1 : 1}
                max={track.unit === "fr" ? 100 : 5000}
                step="any"
                onCommit={(value) => {
                  if (value !== "")
                    onPatch((item) =>
                      updateTrack(item, "column", index, {
                        unit: track.unit,
                        value: Number(value),
                      }),
                    );
                }}
              />
            )}
          </div>
        ))}
        {(node.gridRowTracks ?? []).map((track, index) => (
          <div key={`row-${index}`} className="grid grid-cols-[1fr_1fr_28px] items-end gap-1.5">
            <Choice
              replayOptions
              replayLabel
              label={`Row ${index + 1} unit`}
              value={track.unit}
              choices={[
                ["fr", "Fraction"],
                ["px", "Pixels"],
                ["auto", "Auto"],
              ]}
              onChange={(unit) =>
                onPatch((item) =>
                  updateTrack(
                    item,
                    "row",
                    index,
                    unit === "auto"
                      ? { unit: "auto" }
                      : {
                          unit: unit,
                          value: unit === "fr" ? 1 : 100,
                        },
                  ),
                )
              }
            />
            {track.unit !== "auto" && (
              <PropertyField
                replayLabel
                label={`Row ${index + 1} size`}
                value={track.value}
                numeric
                min={track.unit === "fr" ? 0.1 : 1}
                max={track.unit === "fr" ? 100 : 5000}
                step="any"
                onCommit={(value) => {
                  if (value !== "")
                    onPatch((item) =>
                      updateTrack(item, "row", index, {
                        unit: track.unit,
                        value: Number(value),
                      }),
                    );
                }}
              />
            )}
            <button
              data-ph-public
              type="button"
              aria-label={`Remove row ${index + 1} track`}
              className={buttonClass}
              onClick={() =>
                onPatch((item) => {
                  const tracks = item.gridRowTracks?.filter((_, position) => position !== index);
                  return { gridRowTracks: tracks?.length ? tracks : undefined };
                })
              }
            >
              ×
            </button>
          </div>
        ))}
        <button
          data-ph-public
          type="button"
          className={buttonClass}
          disabled={(node.gridRowTracks?.length ?? 0) >= 12}
          onClick={() =>
            onPatch((item) => ({
              gridRowTracks: [...(item.gridRowTracks ?? []), { unit: "auto" }],
            }))
          }
        >
          Add row track
        </button>
      </div>
    </details>
  );
}
