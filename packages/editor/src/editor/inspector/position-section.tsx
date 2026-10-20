"use client";
import type { SelectionInspectorProps } from "./types";
import { useState } from "react";
import { selectionFields, inspectorButtonClass as buttonClass } from "./fields";
import { parentLayout, type SelectionFeatures, type SelectionLayout } from "./selection";
import { proportionalImageSize } from "../../design/image-sizing";
import { PropertyField } from "../property-field";
import { Choice, Section } from "../inspector-controls";
import { InspectorDisclosure } from "../inspector-presentation";
import { SelectMenu } from "../../components/ui/select-menu";
import { framePresets } from "../../design/frame-presets";

type Props = Pick<
  SelectionInspectorProps,
  "selected" | "document" | "onPatch" | "cropping" | "onScale" | "onAlign" | "onDistribute"
> &
  Pick<SelectionFeatures, "text"> &
  SelectionLayout;

export function PositionSection({
  selected,
  document,
  onPatch,
  cropping,
  onScale,
  onAlign,
  onDistribute,
  text,
  gridChild,
  flowChild,
}: Props) {
  const multi = selected.length > 1;
  const node = selected[0];
  const { common, numberField, styleNumber } = selectionFields(selected, onPatch);
  const [keyObjectId, setKeyObjectId] = useState("");
  const dimensionsInspector = (
    <div className="grid grid-cols-2 gap-2">
      {(["width", "height"] as const).map((axis) => {
        const key = axis === "width" ? "widthMode" : "heightMode";
        const label = axis === "width" ? "Width" : "Height";
        const choices = selected.some((item) => item.vectorBoolean || item.mask)
          ? [{ value: "fixed", label: "Fixed" }]
          : [
              { value: "fixed", label: "Fixed" },
              { value: "fill", label: "Fill" },
              { value: "hug", label: text ? "Auto" : "Hug" },
            ];
        const sizing = common((item) => item[key] ?? "fixed");
        return (
          <div
            key={axis}
            className="inspector-dimension flex min-w-0 items-center gap-1 rounded-md bg-hover-surface px-2 focus-within:ring-1 focus-within:ring-primary-orange"
          >
            <span aria-hidden="true" className="text-[11px] text-secondary-ink">
              {axis === "width" ? "W" : "H"}
            </span>
            <PropertyField
              replayLabel
              label={label}
              layout="embedded"
              value={common((item) => item.box[axis])}
              numeric
              min={1}
              max={5000}
              step="any"
              onCommit={(value) => {
                if (!value) return;
                onPatch((item) => {
                  const locked = item.aspectRatioLocked && !cropping;
                  return {
                    box: locked
                      ? proportionalImageSize(item.box, axis, Number(value))
                      : { [axis]: Number(value) },
                    ...(locked ? { widthMode: "fixed", heightMode: "fixed" } : { [key]: "fixed" }),
                  };
                });
              }}
            />
            <SelectMenu
              label={text ? `Text ${axis}` : `${label} sizing`}
              size="sm"
              value={sizing ?? "__mixed"}
              options={[
                ...(sizing === undefined
                  ? [{ value: "__mixed", label: "Mixed", disabled: true }]
                  : []),
                ...choices,
              ]}
              triggerClassName="flex h-8 w-auto shrink-0 items-center gap-0 border-0 bg-transparent p-0 text-[10px] text-secondary-ink outline-none focus-visible:ring-1 focus-visible:ring-primary-orange"
              onChange={(value) => {
                const choice = choices.find((item) => item.value === value);
                if (choice) onPatch({ [key]: choice.value });
              }}
            />
          </div>
        );
      })}
    </div>
  );
  const scaleInspector = onScale && selected.every((item) => item.parentId === node.parentId) && (
    <PropertyField
      replayLabel
      label="Scale by %"
      value={100}
      numeric
      min={1}
      max={10000}
      step="any"
      onCommit={(value) => {
        if (value !== "") onScale(Number(value) / 100);
      }}
    />
  );
  const positionInspector = (
    <Section
      replayTitle
      title="Size & position"
      action={
        <button
          type="button"
          aria-label="Lock aspect ratio"
          aria-pressed={common((item) => item.aspectRatioLocked ?? false) ?? false}
          onClick={() =>
            onPatch({ aspectRatioLocked: !common((item) => item.aspectRatioLocked ?? false) })
          }
          className="rounded px-1 text-secondary-ink hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-primary-orange"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            aria-hidden="true"
          >
            <path d="M6.5 4H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2.5M9.5 4H12a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H9.5M5 8h6" />
          </svg>
        </button>
      }
    >
      {dimensionsInspector}
      <div className="grid grid-cols-2 gap-2">
        {numberField(
          "X",
          (item) => item.box.x,
          (value) => ({ box: { x: value } }),
          -100000,
          100000,
        )}
        {numberField(
          "Y",
          (item) => item.box.y,
          (value) => ({ box: { y: value } }),
          -100000,
          100000,
        )}
      </div>
      <InspectorDisclosure title="Transform & constraints" nested summary="Expand">
        {selected.every((item) => item.type === "artboard") && (
          <Choice
            replayOptions
            replayLabel
            label="Frame preset"
            value={common(
              (item) =>
                framePresets.find(
                  (preset) => preset.width === item.box.width && preset.height === item.box.height,
                )?.id ?? "",
            )}
            choices={[
              ["", "Custom"],
              ...framePresets.map((preset): [string, string] => [preset.id, preset.label]),
            ]}
            onChange={(id) => {
              const preset = framePresets.find((item) => item.id === id);
              if (preset)
                onPatch({
                  box: { width: preset.width, height: preset.height },
                  widthMode: "fixed",
                  heightMode: "fixed",
                });
            }}
          />
        )}
        {styleNumber("Rotation", "rotation", 0, -360, 360)}
        {scaleInspector}
        {selected.every(
          (item) =>
            item.parentId &&
            (item.positionMode === "absolute" || parentLayout(item, document) === "absolute"),
        ) && (
          <div className="grid grid-cols-2 gap-1.5">
            <Choice
              replayOptions
              replayLabel
              label="Horizontal constraint"
              value={common((item) => item.horizontalConstraint ?? "start")}
              choices={[
                ["start", "Left"],
                ["center", "Center"],
                ["end", "Right"],
                ["stretch", "Left & right"],
                ["scale", "Scale"],
              ]}
              onChange={(value) =>
                onPatch({
                  horizontalConstraint: value,
                  widthMode: "fixed",
                })
              }
            />
            <Choice
              replayOptions
              replayLabel
              label="Vertical constraint"
              value={common((item) => item.verticalConstraint ?? "start")}
              choices={[
                ["start", "Top"],
                ["center", "Center"],
                ["end", "Bottom"],
                ["stretch", "Top & bottom"],
                ["scale", "Scale"],
              ]}
              onChange={(value) =>
                onPatch({
                  verticalConstraint: value,
                  heightMode: "fixed",
                })
              }
            />
          </div>
        )}
        {gridChild && (
          <div className="grid grid-cols-2 gap-1.5">
            {numberField(
              "Column span",
              (item) => item.gridColumnSpan ?? 1,
              (value) => ({ gridColumnSpan: value }),
              1,
              12,
              false,
              1,
            )}
            {numberField(
              "Row span",
              (item) => item.gridRowSpan ?? 1,
              (value) => ({ gridRowSpan: value }),
              1,
              12,
              false,
              1,
            )}
          </div>
        )}
        {flowChild && (
          <div className="grid grid-cols-2 gap-1.5">
            {numberField(
              "Gap adjustment",
              (item) => item.flowGapBefore ?? 0,
              (value) => ({ flowGapBefore: value || undefined }),
              -5000,
              5000,
            )}
            {numberField(
              "Cross offset",
              (item) => item.flowCrossOffset ?? 0,
              (value) => ({ flowCrossOffset: value || undefined }),
              -5000,
              5000,
            )}
          </div>
        )}
        {multi && (
          <Choice
            replayLabel
            label="Align to"
            value={keyObjectId}
            choices={[
              ["", "Selection bounds"],
              ...selected.map((item): [string, string] => [item.id, item.name]),
            ]}
            onChange={setKeyObjectId}
          />
        )}
        {(multi || node.parentId) && (
          <div className="grid grid-cols-3 gap-1">
            {(["left", "center-x", "right", "top", "center-y", "bottom"] as const).map((axis) => (
              <button
                key={axis}
                type="button"
                aria-label={`Align ${axis}`}
                onClick={() => onAlign(axis, keyObjectId || undefined)}
                className={buttonClass}
              >
                {axis.replace("center-x", "H center").replace("center-y", "V center")}
              </button>
            ))}
          </div>
        )}
        {selected.length > 2 && (
          <div className="flex gap-1.5">
            <button
              data-ph-public
              type="button"
              className={buttonClass}
              onClick={() => onDistribute("horizontal")}
            >
              Distribute H
            </button>
            <button
              data-ph-public
              type="button"
              className={buttonClass}
              onClick={() => onDistribute("vertical")}
            >
              Distribute V
            </button>
          </div>
        )}
      </InspectorDisclosure>
    </Section>
  );
  return <>{positionInspector}</>;
}
