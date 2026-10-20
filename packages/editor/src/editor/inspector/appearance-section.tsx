"use client";
import type { SelectionInspectorProps } from "./types";
import type { SelectionFeatures } from "./selection";
import { selectionFields, inspectorButtonClass as buttonClass } from "./fields";
import { resolvedColorTokens } from "../../design/design-tokens";
import { nodePaints, paintStyle } from "../../design/paints";
import { nodeStrokePaints } from "../../design/strokes";
import { Section, Choice, ColorField, applyColor } from "../inspector-controls";
import { InspectorDisclosure } from "../inspector-presentation";
import { FillInspector } from "../fill-inspector";
import { EffectsInspector } from "../effects-inspector";

type Props = Pick<
  SelectionInspectorProps,
  | "selected"
  | "document"
  | "onPatch"
  | "onUploadFill"
  | "onEditImage"
  | "editingGradientId"
  | "onGradientEdit"
  | "viewport"
> &
  Pick<SelectionFeatures, "text" | "vector" | "hasVector">;

export function AppearanceSection({
  selected,
  document,
  onPatch,
  onUploadFill,
  onEditImage,
  editingGradientId,
  onGradientEdit,
  viewport,
  text,
  vector,
  hasVector,
}: Props) {
  const { common, numberField, styleNumber } = selectionFields(selected, onPatch);
  const radiusKeys = [
    "radiusTopLeft",
    "radiusTopRight",
    "radiusBottomRight",
    "radiusBottomLeft",
  ] as const;
  const borderKeys = [
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
  ] as const;
  const separateRadius = selected.some((item) =>
    radiusKeys.some((key) => item.style[key] !== undefined),
  );
  const separateBorder = selected.some((item) =>
    borderKeys.some((key) => item.style[key] !== undefined),
  );
  const tokens = resolvedColorTokens(document);
  const tokenChoice = (label: string, key: "fillToken" | "colorToken" | "borderColorToken") =>
    Object.keys(tokens).length > 0 ? (
      <Choice
        replayLabel
        label={label}
        value={common((item) => item.style[key] ?? "")}
        choices={[
          ["", "Custom"],
          ...Object.keys(tokens).map((name): [string, string] => [name, name]),
        ]}
        onChange={(value) => onPatch({ style: { [key]: value || undefined } })}
      />
    ) : null;

  const appliedExtras = selected.some(
    (item) =>
      nodeStrokePaints(item).length ||
      item.style.shadows?.length ||
      item.style.effects?.length ||
      item.style.shadow ||
      item.style.innerShadow ||
      item.style.backdropBlur ||
      item.style.outlineWidth,
  );

  return (
    <Section title="Appearance" replayTitle>
      <div className="grid grid-cols-2 gap-2">
        {numberField(
          "Opacity %",
          (item) => Math.round((item.style.opacity ?? 1) * 100),
          (value) => ({ style: { opacity: value! / 100 } }),
          0,
          100,
        )}
        {!hasVector &&
          !text &&
          numberField(
            "Radius",
            (item) => (separateRadius ? undefined : (item.style.radius ?? 0)),
            (radius) => ({
              style: {
                radius,
                radiusTopLeft: undefined,
                radiusTopRight: undefined,
                radiusBottomRight: undefined,
                radiusBottomLeft: undefined,
              },
            }),
            0,
            5000,
          )}
      </div>
      {text && (
        <div className="inspector-text-colour">
          {" "}
          <ColorField
            replayLabel
            label="Text color"
            nodes={selected}
            get={(item) =>
              item.style.colorToken
                ? (tokens[item.style.colorToken] ?? item.style.color ?? "#1e1e1e")
                : (item.style.color ?? "#1e1e1e")
            }
            onChange={(value) =>
              onPatch((item) => ({
                style: {
                  color: applyColor(
                    value,
                    item.style.colorToken
                      ? (tokens[item.style.colorToken] ?? item.style.color ?? "#1e1e1e")
                      : (item.style.color ?? "#1e1e1e"),
                  ),
                  colorToken: undefined,
                },
              }))
            }
          />
          {tokenChoice("Text token", "colorToken")}
        </div>
      )}
      <FillInspector
        compact
        selected={selected}
        tokens={tokens}
        onPatch={onPatch}
        onUpload={hasVector ? undefined : onUploadFill}
        onEditImage={onEditImage}
        editingGradientId={editingGradientId}
        onGradientEdit={hasVector ? undefined : onGradientEdit}
        viewport={viewport}
      />
      <InspectorDisclosure
        title={appliedExtras ? "Stroke & effects" : "Add appearance"}
        summary={appliedExtras ? "Applied" : undefined}
        nested
      >
        {selected.some((item) => nodePaints(item).length === 0) && (
          <button
            type="button"
            className={buttonClass}
            onClick={() =>
              onPatch((item) => ({
                style: paintStyle([
                  {
                    id: crypto.randomUUID(),
                    type: "solid",
                    color: "#ffffff",
                    opacity: 1,
                    visible: true,
                  },
                  ...nodePaints(item),
                ]),
              }))
            }
          >
            Add fill
          </button>
        )}
        <FillInspector
          mode="stroke"
          selected={selected}
          tokens={tokens}
          onPatch={onPatch}
          viewport={viewport}
        >
          {!hasVector && (
            <button
              data-ph-public
              data-ph-public-label
              type="button"
              aria-label="Independent border widths"
              aria-pressed={separateBorder}
              className={buttonClass}
              onClick={() =>
                onPatch((item) => ({
                  style: separateBorder
                    ? {
                        borderWidth: item.style.borderTopWidth ?? item.style.borderWidth ?? 0,
                        borderTopWidth: undefined,
                        borderRightWidth: undefined,
                        borderBottomWidth: undefined,
                        borderLeftWidth: undefined,
                      }
                    : {
                        borderTopWidth: item.style.borderWidth ?? 0,
                        borderRightWidth: item.style.borderWidth ?? 0,
                        borderBottomWidth: item.style.borderWidth ?? 0,
                        borderLeftWidth: item.style.borderWidth ?? 0,
                      },
                }))
              }
            >
              {separateBorder ? "Link sides" : "Each side"}
            </button>
          )}
          {!hasVector && separateBorder ? (
            <div className="grid grid-cols-2 gap-1.5">
              {borderKeys.map((key, index) =>
                numberField(
                  ["Border top", "Border right", "Border bottom", "Border left"][index],
                  (item) => item.style[key] ?? item.style.borderWidth ?? 0,
                  (value) => ({ style: { [key]: value } }),
                  0,
                  40,
                ),
              )}
            </div>
          ) : (
            styleNumber(
              vector ? "Stroke width (SVG units)" : "Border width",
              "borderWidth",
              0,
              0,
              40,
            )
          )}
          {selected.some(
            (item) =>
              (item.style.borderWidth ?? 0) > 0 ||
              borderKeys.some((key) => (item.style[key] ?? 0) > 0),
          ) && (
            <>
              {!hasVector && (
                <Choice
                  replayOptions
                  replayLabel
                  label="Stroke position"
                  value={common((item) => item.style.strokePosition ?? "inside")}
                  choices={[
                    ["inside", "Inside"],
                    ["center", "Center"],
                    ["outside", "Outside"],
                  ]}
                  onChange={(value) =>
                    onPatch({
                      style: {
                        strokePosition: value,
                      },
                    })
                  }
                />
              )}
              {vector && (
                <>
                  <Choice
                    replayOptions
                    replayLabel
                    label="Line cap"
                    value={common((item) => item.style.strokeCap ?? "butt")}
                    choices={[
                      ["butt", "Butt"],
                      ["round", "Round"],
                      ["square", "Square"],
                    ]}
                    onChange={(value) =>
                      onPatch({
                        style: { strokeCap: value },
                      })
                    }
                  />
                  <Choice
                    replayOptions
                    replayLabel
                    label="Line join"
                    value={common((item) => item.style.strokeJoin ?? "miter")}
                    choices={[
                      ["miter", "Miter"],
                      ["round", "Round"],
                      ["bevel", "Bevel"],
                    ]}
                    onChange={(value) =>
                      onPatch({
                        style: { strokeJoin: value },
                      })
                    }
                  />
                  {selected.every(
                    (item) => item.vectorPath && !/[zZ]\s*$/.test(item.vectorPath.d),
                  ) &&
                    (["strokeStart", "strokeEnd"] as const).map((key) => (
                      <Choice
                        replayOptions
                        replayLabel
                        key={key}
                        label={key === "strokeStart" ? "Start marker" : "End marker"}
                        value={common((item) => item.style[key] ?? "none")}
                        choices={[
                          ["none", "None"],
                          ["arrow", "Arrow"],
                          ["triangle", "Triangle"],
                          ["circle", "Circle"],
                        ]}
                        onChange={(value) => onPatch({ style: { [key]: value } })}
                      />
                    ))}
                </>
              )}
              <Choice
                replayOptions
                replayLabel
                label="Border style"
                value={common((item) => item.style.borderStyle ?? "solid")}
                choices={[
                  ["solid", "Solid"],
                  ["dashed", "Dashed"],
                  ["dotted", "Dotted"],
                ]}
                onChange={(value) =>
                  onPatch({
                    style: { borderStyle: value },
                  })
                }
              />
            </>
          )}
        </FillInspector>
        <EffectsInspector selected={selected} onPatch={onPatch} />
        <details className="border-b border-primary-grey/60">
          <summary data-ph-public className="cursor-pointer px-4 py-3 text-xs font-medium">
            Outline
          </summary>
          <div className="space-y-2 px-4 pb-3">
            {styleNumber("Outline width", "outlineWidth", 0, 0, 40)}
            <ColorField
              replayLabel
              label="Outline color"
              nodes={selected}
              get={(item) => item.style.outlineColor ?? "#000000"}
              onChange={(value) =>
                onPatch((item) => ({
                  style: {
                    outlineColor: applyColor(value, item.style.outlineColor ?? "#000000"),
                  },
                }))
              }
            />
          </div>
        </details>
      </InspectorDisclosure>
      <InspectorDisclosure title="More appearance" nested summary="Expand">
        <Choice
          label="Blend mode"
          value={common((item) => item.style.blendMode ?? "normal")}
          choices={(["normal", "multiply", "screen", "overlay", "darken", "lighten"] as const).map(
            (mode) => [mode, mode] as const,
          )}
          onChange={(value) => onPatch({ style: { blendMode: value } })}
        />
        {!hasVector && (
          <Section
            replayTitle
            title="Corners"
            action={
              <button
                data-ph-public
                data-ph-public-label
                type="button"
                aria-label="Independent corner radii"
                aria-pressed={separateRadius}
                className={buttonClass}
                onClick={() =>
                  onPatch((item) => ({
                    style: separateRadius
                      ? {
                          radius: item.style.radiusTopLeft ?? item.style.radius ?? 0,
                          radiusTopLeft: undefined,
                          radiusTopRight: undefined,
                          radiusBottomRight: undefined,
                          radiusBottomLeft: undefined,
                        }
                      : {
                          radiusTopLeft: item.style.radius ?? 0,
                          radiusTopRight: item.style.radius ?? 0,
                          radiusBottomRight: item.style.radius ?? 0,
                          radiusBottomLeft: item.style.radius ?? 0,
                        },
                  }))
                }
              >
                {separateRadius ? "Link corners" : "Each corner"}
              </button>
            }
          >
            {separateRadius ? (
              <div className="grid grid-cols-2 gap-1.5">
                {radiusKeys.map((key, index) =>
                  numberField(
                    [
                      "Top left radius",
                      "Top right radius",
                      "Bottom right radius",
                      "Bottom left radius",
                    ][index],
                    (item) => item.style[key] ?? item.style.radius ?? 0,
                    (value) => ({ style: { [key]: value } }),
                    0,
                    5000,
                  ),
                )}
              </div>
            ) : text ? (
              styleNumber("Radius", "radius", 0, 0, 5000)
            ) : null}
            {selected.some(
              (item) =>
                (item.style.radius ?? 0) > 0 ||
                radiusKeys.some((key) => (item.style[key] ?? 0) > 0),
            ) &&
              numberField(
                "Corner smoothing %",
                (item) => (item.style.cornerSmoothing ?? 0) * 100,
                (value) => ({ style: { cornerSmoothing: (value ?? 0) / 100 } }),
                0,
                100,
              )}
          </Section>
        )}
      </InspectorDisclosure>
    </Section>
  );
}
