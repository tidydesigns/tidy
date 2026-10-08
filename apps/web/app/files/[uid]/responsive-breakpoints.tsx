"use client";

import type { DesignDocument, DesignNode } from "@/lib/design/document";
import { containingFrameWidth, responsiveNode } from "@/lib/design/responsive-layout";
import { Choice, type Patch } from "./inspector-controls";
import { PropertyField } from "./property-field";

type Breakpoint = NonNullable<DesignNode["responsiveBreakpoints"]>[number];
type GridTrack = NonNullable<DesignNode["gridColumnTracks"]>[number];
const buttonClass =
  "rounded-md border border-primary-grey/70 px-2 py-1.5 text-xs hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange";

export function ResponsiveBreakpoints({
  node,
  document,
  onPatch,
}: {
  node: DesignNode;
  document: DesignDocument;
  onPatch: (patch: Patch) => void;
}) {
  const frameWidth = containingFrameWidth(node, document.nodes);
  const container = node.type === "artboard" || node.type === "container";
  const breakpoints = [...(node.responsiveBreakpoints ?? [])].sort(
    (a, b) => b.frameMaxWidth - a.frameMaxWidth,
  );
  function update(id: string, changes: Partial<Breakpoint>) {
    onPatch((item) => {
      const responsiveBreakpoints = item.responsiveBreakpoints?.map((breakpoint) => {
        if (breakpoint.id !== id) return breakpoint;
        const next = { ...breakpoint, ...changes };
        if (changes.gap !== undefined) {
          next.columnGap = undefined;
          next.rowGap = undefined;
        }
        if (changes.padding !== undefined) {
          next.paddingTop = undefined;
          next.paddingRight = undefined;
          next.paddingBottom = undefined;
          next.paddingLeft = undefined;
        }
        if (changes.gridColumns !== undefined) next.gridColumnTracks = undefined;
        return next;
      });
      const next = responsiveBreakpoints?.find((breakpoint) => breakpoint.id === id);
      if (next && (Object.hasOwn(changes, "layout") || Object.hasOwn(changes, "wrap"))) {
        const rendered = responsiveNode({ ...item, responsiveBreakpoints }, next.frameMaxWidth);
        if ((rendered.layout === "grid" || rendered.wrap) && (rendered.gap ?? 0) < 0) next.gap = 0;
      }
      return { responsiveBreakpoints };
    });
  }
  function add() {
    const used = new Set(breakpoints.map((breakpoint) => breakpoint.frameMaxWidth));
    let frameMaxWidth = Math.min(768, Math.max(1, Math.floor(frameWidth) - 1));
    while (used.has(frameMaxWidth) && frameMaxWidth < 5000) frameMaxWidth++;
    onPatch((item) => ({
      responsiveBreakpoints: [
        ...(item.responsiveBreakpoints ?? []),
        { id: crypto.randomUUID(), frameMaxWidth },
      ],
    }));
  }
  const numeric = (
    breakpoint: Breakpoint,
    label: string,
    key:
      | "gap"
      | "columnGap"
      | "rowGap"
      | "padding"
      | "paddingTop"
      | "paddingRight"
      | "paddingBottom"
      | "paddingLeft"
      | "gridColumns",
    min: number,
    max: number,
  ) => (
    <PropertyField
      label={label}
      value={breakpoint[key] ?? ""}
      numeric
      min={min}
      max={max}
      step={key === "gridColumns" ? 1 : "any"}
      onCommit={(value) =>
        update(breakpoint.id, { [key]: value === "" ? undefined : Number(value) })
      }
    />
  );
  function updateTrack(
    breakpoint: Breakpoint,
    axis: "column" | "row",
    index: number,
    track: GridTrack,
  ) {
    const rendered = responsiveNode(node, breakpoint.frameMaxWidth);
    const tracks =
      axis === "column"
        ? (rendered.gridColumnTracks ??
          Array.from({ length: rendered.gridColumns ?? 2 }, (): GridTrack => ({
            unit: "fr",
            value: 1,
          })))
        : (rendered.gridRowTracks ?? []);
    update(breakpoint.id, {
      [axis === "column" ? "gridColumnTracks" : "gridRowTracks"]: tracks.map((item, position) =>
        position === index ? track : item,
      ),
    });
  }

  return (
    <details className="rounded-md border border-primary-grey/70 px-2 py-1.5 text-xs">
      <summary className="cursor-pointer">Responsive breakpoints</summary>
      <div className="mt-2 max-h-96 space-y-2 overflow-y-auto">
        <div className="flex items-center justify-between gap-2 text-[10px] text-secondary-ink">
          <span>Frame width {Math.round(frameWidth)}px</span>
          <button
            type="button"
            className={buttonClass}
            disabled={breakpoints.length >= 8}
            onClick={add}
          >
            Add breakpoint
          </button>
        </div>
        {breakpoints.map((breakpoint) => {
          const rendered = responsiveNode(node, breakpoint.frameMaxWidth);
          const columns =
            rendered.gridColumnTracks ??
            Array.from({ length: rendered.gridColumns ?? 2 }, (): GridTrack => ({
              unit: "fr",
              value: 1,
            }));
          const rows = rendered.gridRowTracks ?? [];
          return (
            <div
              key={breakpoint.id}
              className="space-y-1.5 rounded-md border border-primary-grey/70 p-2"
            >
              <div className="flex items-end gap-1.5">
                <div className="min-w-0 flex-1">
                  <PropertyField
                    label="Frame width up to"
                    value={breakpoint.frameMaxWidth}
                    numeric
                    min={1}
                    max={5000}
                    step={1}
                    onCommit={(value) => {
                      if (value !== "")
                        update(breakpoint.id, { frameMaxWidth: Math.round(Number(value)) });
                    }}
                  />
                </div>
                <button
                  type="button"
                  aria-label={`Remove breakpoint ${breakpoint.frameMaxWidth}`}
                  className={buttonClass}
                  onClick={() =>
                    onPatch((item) => ({
                      responsiveBreakpoints: item.responsiveBreakpoints?.filter(
                        (entry) => entry.id !== breakpoint.id,
                      ),
                    }))
                  }
                >
                  ×
                </button>
              </div>
              {frameWidth <= breakpoint.frameMaxWidth && (
                <span className="text-[10px] text-accent-ink">Active at this frame width</span>
              )}
              {container && (
                <>
                  <Choice
                    label="Breakpoint flow"
                    value={breakpoint.layout ?? ""}
                    choices={[
                      ["", "Inherit"],
                      ["absolute", "Free position"],
                      ["flex-row", "Horizontal"],
                      ["flex-column", "Vertical"],
                      ["grid", "Grid"],
                    ]}
                    onChange={(value) =>
                      update(breakpoint.id, {
                        layout: value ? (value as DesignNode["layout"]) : undefined,
                      })
                    }
                  />
                  {rendered.layout !== "absolute" && (
                    <>
                      {numeric(
                        breakpoint,
                        "Breakpoint gap",
                        "gap",
                        rendered.layout === "grid" || rendered.wrap ? 0 : -1000,
                        1000,
                      )}
                      {(rendered.layout === "grid" || rendered.wrap) && (
                        <div className="grid grid-cols-2 gap-1.5">
                          {numeric(breakpoint, "Breakpoint column gap", "columnGap", 0, 1000)}
                          {numeric(breakpoint, "Breakpoint row gap", "rowGap", 0, 1000)}
                        </div>
                      )}
                    </>
                  )}
                  {numeric(breakpoint, "Breakpoint padding", "padding", 0, 1000)}
                  <details className="rounded-md border border-primary-grey/70 px-2 py-1.5">
                    <summary className="cursor-pointer">Padding by side</summary>
                    <div className="mt-2 grid grid-cols-2 gap-1.5">
                      {(
                        ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const
                      ).map((key) => (
                        <div key={key}>
                          {numeric(
                            breakpoint,
                            `Breakpoint ${key.replace(/([A-Z])/g, " $1").toLowerCase()}`,
                            key,
                            0,
                            1000,
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                  {rendered.layout === "grid" && (
                    <>
                      {numeric(breakpoint, "Breakpoint columns", "gridColumns", 1, 12)}
                      <details className="rounded-md border border-primary-grey/70 px-2 py-1.5">
                        <summary className="cursor-pointer">Breakpoint grid tracks</summary>
                        <div className="mt-2 space-y-2">
                          {columns.map((track, index) => (
                            <div
                              key={`column-${index}`}
                              className="grid grid-cols-2 items-end gap-1.5"
                            >
                              <Choice
                                label={`Breakpoint column ${index + 1} unit`}
                                value={track.unit}
                                choices={[
                                  ["fr", "Fraction"],
                                  ["px", "Pixels"],
                                  ["auto", "Auto"],
                                ]}
                                onChange={(unit) =>
                                  updateTrack(
                                    breakpoint,
                                    "column",
                                    index,
                                    unit === "auto"
                                      ? { unit: "auto" }
                                      : {
                                          unit: unit as "fr" | "px",
                                          value: unit === "fr" ? 1 : 100,
                                        },
                                  )
                                }
                              />
                              {track.unit !== "auto" && (
                                <PropertyField
                                  label={`Breakpoint column ${index + 1} size`}
                                  value={track.value}
                                  numeric
                                  min={track.unit === "fr" ? 0.1 : 1}
                                  max={track.unit === "fr" ? 100 : 5000}
                                  step="any"
                                  onCommit={(value) => {
                                    if (value !== "")
                                      updateTrack(breakpoint, "column", index, {
                                        unit: track.unit,
                                        value: Number(value),
                                      });
                                  }}
                                />
                              )}
                            </div>
                          ))}
                          {breakpoint.gridColumnTracks && (
                            <button
                              type="button"
                              className={buttonClass}
                              onClick={() => update(breakpoint.id, { gridColumnTracks: undefined })}
                            >
                              Reset breakpoint columns
                            </button>
                          )}
                          {rows.map((track, index) => (
                            <div
                              key={`row-${index}`}
                              className="grid grid-cols-[1fr_1fr_28px] items-end gap-1.5"
                            >
                              <Choice
                                label={`Breakpoint row ${index + 1} unit`}
                                value={track.unit}
                                choices={[
                                  ["fr", "Fraction"],
                                  ["px", "Pixels"],
                                  ["auto", "Auto"],
                                ]}
                                onChange={(unit) =>
                                  updateTrack(
                                    breakpoint,
                                    "row",
                                    index,
                                    unit === "auto"
                                      ? { unit: "auto" }
                                      : {
                                          unit: unit as "fr" | "px",
                                          value: unit === "fr" ? 1 : 100,
                                        },
                                  )
                                }
                              />
                              {track.unit !== "auto" && (
                                <PropertyField
                                  label={`Breakpoint row ${index + 1} size`}
                                  value={track.value}
                                  numeric
                                  min={track.unit === "fr" ? 0.1 : 1}
                                  max={track.unit === "fr" ? 100 : 5000}
                                  step="any"
                                  onCommit={(value) => {
                                    if (value !== "")
                                      updateTrack(breakpoint, "row", index, {
                                        unit: track.unit,
                                        value: Number(value),
                                      });
                                  }}
                                />
                              )}
                              <button
                                type="button"
                                aria-label={`Remove breakpoint row ${index + 1} track`}
                                className={buttonClass}
                                onClick={() =>
                                  update(breakpoint.id, {
                                    gridRowTracks: rows.filter((_, position) => position !== index),
                                  })
                                }
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            className={buttonClass}
                            disabled={rows.length >= 12}
                            onClick={() =>
                              update(breakpoint.id, { gridRowTracks: [...rows, { unit: "auto" }] })
                            }
                          >
                            Add breakpoint row track
                          </button>
                        </div>
                      </details>
                    </>
                  )}
                  {(["flex-row", "flex-column", "grid"] as const).includes(
                    rendered.layout as "flex-row" | "flex-column" | "grid",
                  ) && (
                    <div className="grid grid-cols-2 gap-1.5">
                      <Choice
                        label="Breakpoint align"
                        value={breakpoint.align ?? ""}
                        choices={[
                          ["", "Inherit"],
                          ["start", "Start"],
                          ["center", "Center"],
                          ["end", "End"],
                          ["stretch", "Stretch"],
                          ["baseline", "Baseline"],
                        ]}
                        onChange={(value) =>
                          update(breakpoint.id, {
                            align: value ? (value as DesignNode["align"]) : undefined,
                          })
                        }
                      />
                      <Choice
                        label="Breakpoint justify"
                        value={breakpoint.justify ?? ""}
                        choices={[
                          ["", "Inherit"],
                          ["start", "Start"],
                          ["center", "Center"],
                          ["end", "End"],
                          ["space-between", "Space between"],
                        ]}
                        onChange={(value) =>
                          update(breakpoint.id, {
                            justify: value ? (value as DesignNode["justify"]) : undefined,
                          })
                        }
                      />
                    </div>
                  )}
                  {(["flex-row", "flex-column"] as const).includes(
                    rendered.layout as "flex-row" | "flex-column",
                  ) && (
                    <Choice
                      label="Breakpoint wrap"
                      value={breakpoint.wrap === undefined ? "" : String(breakpoint.wrap)}
                      choices={[
                        ["", "Inherit"],
                        ["true", "Wrap"],
                        ["false", "No wrap"],
                      ]}
                      onChange={(value) =>
                        update(breakpoint.id, { wrap: value === "" ? undefined : value === "true" })
                      }
                    />
                  )}
                </>
              )}
              {node.type !== "artboard" && (
                <div className="grid grid-cols-2 gap-1.5">
                  <Choice
                    label="Breakpoint width"
                    value={breakpoint.widthMode ?? ""}
                    choices={[
                      ["", "Inherit"],
                      ["fixed", "Fixed"],
                      ["fill", "Fill"],
                      ["hug", "Hug"],
                    ]}
                    onChange={(value) =>
                      update(breakpoint.id, {
                        widthMode: value ? (value as DesignNode["widthMode"]) : undefined,
                      })
                    }
                  />
                  <Choice
                    label="Breakpoint height"
                    value={breakpoint.heightMode ?? ""}
                    choices={[
                      ["", "Inherit"],
                      ["fixed", "Fixed"],
                      ["fill", "Fill"],
                      ["hug", "Hug"],
                    ]}
                    onChange={(value) =>
                      update(breakpoint.id, {
                        heightMode: value ? (value as DesignNode["heightMode"]) : undefined,
                      })
                    }
                  />
                </div>
              )}
              {node.type !== "artboard" && (
                <div className="grid grid-cols-2 gap-1.5">
                  {(["minWidth", "maxWidth", "minHeight", "maxHeight"] as const).map((key) => (
                    <PropertyField
                      key={key}
                      label={`Breakpoint ${key.replace(/([A-Z])/g, " $1").toLowerCase()}`}
                      value={breakpoint[key] ?? ""}
                      numeric
                      min={key.startsWith("min") ? 0 : 1}
                      max={5000}
                      step="any"
                      onCommit={(value) =>
                        update(breakpoint.id, { [key]: value === "" ? undefined : Number(value) })
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
