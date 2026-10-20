"use client";
import type { SelectionInspectorProps } from "./types";
import type { DesignNode } from "../../design/document";
import { selectionFields, inspectorButtonClass as buttonClass } from "./fields";
import { useRichTextSelection, RichTextSelectionControls } from "../rich-text-selection";
import { formatNodeText, nodeTextFormatting } from "../../design/text-formatting";
import { canvasElements } from "../canvas-elements";
import { fontRegistry } from "../../design/fonts/runtime";
import { Section, Choice } from "../inspector-controls";
import { FontPicker } from "../font-picker";
import { PropertyField } from "../property-field";
const lineHeightMeasurements = new Map<string, number>();

type Props = Pick<SelectionInspectorProps, "selected" | "onPatch" | "viewport">;
export function TypographySection({ selected, onPatch, viewport }: Props) {
  const multi = selected.length > 1;
  const node = selected[0];
  const richSelection = useRichTextSelection();
  const editingSelection = richSelection?.nodeId === node.id ? richSelection : null;
  const { common, numberField, styleNumber } = selectionFields(selected, onPatch);
  function lineHeightPx(item: DesignNode) {
    const element = canvasElements(viewport?.current).get(item.id);
    const computed = element ? getComputedStyle(element) : undefined;
    const fontSize = computed ? parseFloat(computed.fontSize) : (item.style.fontSize ?? 16);
    if (item.style.lineHeightMode === "px")
      return item.style.lineHeightPx ?? fontSize * (item.style.lineHeight ?? 1.35);
    if (
      (item.style.lineHeightMode ?? (item.style.lineHeight === undefined ? "auto" : "percent")) !==
      "auto"
    )
      return fontSize * (item.style.lineHeight ?? 1.35);
    if (!computed) return fontSize * 1.2;
    const cacheKey = JSON.stringify([
      computed.fontFamily,
      computed.fontSize,
      computed.fontWeight,
      computed.fontStyle,
      fontRegistry.snapshot(),
    ]);
    const cached = lineHeightMeasurements.get(cacheKey);
    if (cached !== undefined) return cached;
    const probe = globalThis.document.createElement("span");
    Object.assign(probe.style, {
      display: "block",
      position: "absolute",
      visibility: "hidden",
      width: "max-content",
      padding: "0",
      border: "0",
      lineHeight: "normal",
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      fontWeight: computed.fontWeight,
      fontStyle: computed.fontStyle,
    });
    probe.textContent = "Hg";
    globalThis.document.body.appendChild(probe);
    const measured = probe.getBoundingClientRect().height;
    probe.remove();
    const result = measured || fontSize * 1.2;
    lineHeightMeasurements.set(cacheKey, result);
    if (lineHeightMeasurements.size > 128)
      lineHeightMeasurements.delete(lineHeightMeasurements.keys().next().value!);
    return result;
  }
  const lineHeightMode = (item: DesignNode) =>
    item.style.lineHeightMode ?? (item.style.lineHeight === undefined ? "auto" : "percent");

  return (
    <Section replayTitle title="Typography">
      <FontPicker
        replayLabel
        selected={selected}
        onPatch={onPatch}
        sizeControl={styleNumber("Font size", "fontSize", 16, 6, 300)}
      />

      <div className="grid grid-cols-2 gap-2">
        <PropertyField
          replayLabel
          label={
            common(lineHeightMode) === "percent"
              ? "Line height %"
              : common(lineHeightMode) === "px"
                ? "Line height px"
                : "Line height"
          }
          numeric
          placeholder="Auto"
          min={common(lineHeightMode) === "percent" ? 0.01 : 0.1}
          max={common(lineHeightMode) === "percent" ? 20000 : 1200}
          value={common((item) =>
            lineHeightMode(item) === "auto"
              ? undefined
              : lineHeightMode(item) === "px"
                ? (item.style.lineHeightPx ?? lineHeightPx(item))
                : (item.style.lineHeight ?? 1.35) * 100,
          )}
          onCommit={(value) =>
            onPatch({
              style:
                value === ""
                  ? {
                      lineHeightMode: "auto",
                      lineHeight: undefined,
                      lineHeightPx: undefined,
                    }
                  : common(lineHeightMode) === "percent"
                    ? { lineHeightMode: "percent", lineHeight: Number(value) / 100 }
                    : { lineHeightMode: "px", lineHeightPx: Number(value) },
            })
          }
        />
        {styleNumber("Letter spacing", "letterSpacing", 0, -100, 100)}
      </div>
      <div>
        <Choice
          replayOptions
          replayLabel
          label="Text align"
          value={common((item) => item.style.textAlign ?? "left")}
          choices={[
            ["left", "Left"],
            ["center", "Center"],
            ["right", "Right"],
          ]}
          onChange={(value) => onPatch({ style: { textAlign: value } })}
        />
      </div>
      <details>
        <summary className="cursor-pointer py-1 text-xs text-secondary-ink focus-visible:outline-2 focus-visible:outline-primary-orange">
          Text details
        </summary>
        <div className="mt-2 space-y-2">
          {" "}
          <Choice
            replayOptions
            replayLabel
            label="Text case"
            value={common((item) => item.style.textCase ?? "none")}
            choices={[
              ["none", "Original"],
              ["uppercase", "UPPERCASE"],
              ["lowercase", "lowercase"],
              ["capitalize", "Title Case"],
            ]}
            onChange={(value) => onPatch({ style: { textCase: value } })}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <Choice
              replayOptions
              replayLabel
              label="Line height mode"
              value={common(lineHeightMode)}
              choices={[
                ["auto", "Auto"],
                ["percent", "%"],
                ["px", "px"],
              ]}
              onChange={(mode) =>
                onPatch((item) => {
                  const pixels = lineHeightPx(item);
                  const element = canvasElements(viewport?.current).get(item.id);
                  const fontSize = element
                    ? parseFloat(getComputedStyle(element).fontSize)
                    : (item.style.fontSize ?? 16);
                  return {
                    style:
                      mode === "auto"
                        ? { lineHeightMode: "auto" }
                        : mode === "px"
                          ? {
                              lineHeightMode: "px",
                              lineHeightPx: Math.max(0.1, Math.min(1200, pixels)),
                            }
                          : {
                              lineHeightMode: "percent",
                              lineHeight: Math.max(0.0001, Math.min(200, pixels / fontSize)),
                            },
                  };
                })
              }
            />
          </div>
          {numberField(
            "Paragraph spacing",
            (item) => item.style.paragraphSpacing ?? 0,
            (value) => ({ style: { paragraphSpacing: value } }),
            0,
            1000,
          )}
          {selected.some((item) => item.heightMode !== "hug") && (
            <Choice
              replayOptions
              replayLabel
              label="Vertical align"
              value={common((item) => item.style.textVerticalAlign ?? "top")}
              choices={[
                ["top", "Top"],
                ["center", "Middle"],
                ["bottom", "Bottom"],
              ]}
              onChange={(value) =>
                onPatch({
                  style: {
                    textVerticalAlign: value,
                  },
                })
              }
            />
          )}
          {multi && (
            <div className="flex gap-1.5">
              {(["underline", "line-through"] as const).map((decoration) => (
                <button
                  data-ph-public
                  key={decoration}
                  type="button"
                  aria-pressed={common((item) => item.style.textDecoration === decoration) ?? false}
                  className={buttonClass}
                  onClick={() =>
                    onPatch({
                      style: {
                        textDecoration: common((item) => item.style.textDecoration === decoration)
                          ? "none"
                          : decoration,
                      },
                    })
                  }
                >
                  {decoration === "underline" ? "Underline" : "Strike"}
                </button>
              ))}
            </div>
          )}
          <Choice
            replayOptions
            replayLabel
            label="Text wrapping"
            value={common((item) => item.style.textWrap ?? "wrap")}
            choices={[
              ["wrap", "Wrap"],
              ["nowrap", "Single line"],
            ]}
            onChange={(value) => onPatch({ style: { textWrap: value } })}
          />
          {selected.every((item) => item.style.textWrap === "nowrap") && (
            <Choice
              replayOptions
              replayLabel
              label="Truncation"
              value={common((item) => item.style.textOverflow ?? "clip")}
              choices={[
                ["clip", "Clip"],
                ["ellipsis", "Ellipsis"],
              ]}
              onChange={(value) =>
                onPatch({
                  style: { textOverflow: value },
                })
              }
            />
          )}
          {numberField(
            "Maximum lines",
            (item) => item.style.maxLines,
            (value) => ({ style: { maxLines: value } }),
            1,
            100,
            true,
          )}
        </div>
      </details>
      {!multi && (
        <details data-rich-text-controls>
          <summary className="cursor-pointer py-1 text-xs text-secondary-ink focus-visible:outline-2 focus-visible:outline-primary-orange">
            Formatting
          </summary>
          <div className="pt-2">
            <RichTextSelectionControls
              selection={editingSelection ?? { nodeId: node.id, ...nodeTextFormatting(node) }}
              onCommand={
                editingSelection
                  ? undefined
                  : (command, value) =>
                      onPatch((item) => formatNodeText({ node: item, command, value }))
              }
              onFinishEditing={
                editingSelection
                  ? () => viewport?.current?.focus({ preventScroll: true })
                  : undefined
              }
            />
          </div>
        </details>
      )}
    </Section>
  );
}
