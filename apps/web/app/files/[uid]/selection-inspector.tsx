"use client";
import { nativeShapePath } from "@bella/design/native-shapes";
import { InstanceControls } from "./instance-controls";
import { HandoffInspector } from "./handoff-inspector";
import { useRichTextSelection, RichTextSelectionControls } from "./rich-text-selection";
import { fontRegistry } from "@/lib/design/fonts/runtime";

import {
  createVectorBoolean,
  createVectorMask,
  releaseVectorComposite,
} from "@/lib/design/vector-composite-operations";
import { vectorMaskSource, vectorOperand } from "@bella/design/vector-relationships";
import type { VectorBoolean } from "@bella/design/vector-boolean";
import { ComponentPropertiesInspector } from "./component-properties-inspector";
import { ReusableStylesInspector } from "./reusable-styles-inspector";
import { ExportControls } from "./export-controls";
import type { ExportRequest } from "@/lib/design/export-plan";
import { SelectMenu } from "@/components/ui/select-menu";
import { componentFamily } from "@/lib/design/component-variants";
import { renderedNodeBox } from "@/lib/design/canvas-geometry";
import { canvasElements } from "./canvas-elements";

import { memo, useState, type RefObject } from "react";
import { reparentLayer } from "@/lib/design/document-operations";
import type { DesignDocument, DesignNode } from "@/lib/design/document";
import { useRenderedSelection } from "./use-rendered-selection";
import { zoomImageCrop } from "@/lib/design/image-crop";
import { PropertyField } from "./property-field";
import { FontPicker } from "./font-picker";
import { Choice, Section, ColorField, shared, applyColor, type Patch } from "./inspector-controls";
import { EffectsInspector } from "./effects-inspector";
import { FillInspector } from "./fill-inspector";
import { framePresets } from "@/lib/design/frame-presets";
import { containingFrameWidth, responsiveNode } from "@/lib/design/responsive-layout";
import { ResponsiveBreakpoints } from "./responsive-breakpoints";
import { TokenBindings } from "./token-bindings";
import { resolvedColorTokens } from "@/lib/design/design-tokens";

const buttonClass =
  "rounded-md border border-primary-grey/70 px-2 py-1.5 text-xs hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange active:scale-[0.97]";
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

const lineHeightMeasurements = new Map<string, number>();

export const SelectionInspector = memo(function SelectionInspector({
  selected: sourceSelection,
  mode = "design",
  document,
  onPatch,
  onDocument,
  onExport,
  exportPending = false,
  exportWarnings = [],
  onReplaceImage,
  onUploadFill,
  editingGradientId,
  onGradientEdit,
  onCropImage,
  onEditVector,
  editingVector = false,
  cropping = false,
  onClose,
  onGoToMaster,
  onAlign,
  onDistribute,
  onGroup,
  onScale,
  readOnly = false,
  viewport,
}: {
  selected: DesignNode[];
  mode?: "design" | "inspect";
  document: DesignDocument;
  readOnly?: boolean;
  onPatch: (changes: Patch) => void;
  editingGradientId?: string;
  onGradientEdit?: (id: string | null) => void;
  viewport?: RefObject<HTMLDivElement | null>;
  onDocument: (
    transform: (document: DesignDocument) => DesignDocument,
    nextSelection?: string,
  ) => void;
  onExport: (request: ExportRequest) => void;
  exportPending?: boolean;
  exportWarnings?: string[];
  onReplaceImage: () => void;
  onUploadFill?: (index: number, file: File) => Promise<void>;
  onCropImage?: () => void;
  cropping?: boolean;
  onEditVector?: () => void;
  editingVector?: boolean;
  onPrototype: () => void;
  onClose?: () => void;
  onGoToMaster?: (id: string) => void;
  onAlign: (
    axis: "left" | "center-x" | "right" | "top" | "center-y" | "bottom",
    keyObjectId?: string,
  ) => void;
  onDistribute: (axis: "horizontal" | "vertical") => void;
  onGroup: () => void;
  onScale?: (factor: number) => void;
}) {
  const richSelection = useRichTextSelection();
  const selected = useRenderedSelection(sourceSelection, document, viewport);
  const multi = selected.length > 1;
  const inspect = readOnly || mode === "inspect";
  const [keyObjectId, setKeyObjectId] = useState("");
  const [maskSourceId, setMaskSourceId] = useState("");
  const node = selected[0];
  const instance = !multi && node.instanceOf && node.componentSourceId === node.instanceOf;
  const family = !multi ? componentFamily(document.nodes, node) : undefined;
  const parentLayout = (item: DesignNode) => {
    const parent = document.nodes.find((candidate) => candidate.id === item.parentId);
    return parent
      ? responsiveNode(parent, containingFrameWidth(parent, document.nodes)).layout
      : undefined;
  };
  const gridChild = selected.every(
    (item) => item.parentId && parentLayout(item) === "grid" && item.positionMode !== "absolute",
  );
  const flowChild = selected.every(
    (item) =>
      item.parentId &&
      ["flex-row", "flex-column"].includes(parentLayout(item) ?? "") &&
      item.positionMode !== "absolute",
  );
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
  const containers = selected.every(
    (item) =>
      (item.type === "artboard" || item.type === "container") && !item.vectorBoolean && !item.mask,
  );
  const text = selected.every((item) => item.type === "text");
  const vector = selected.every((item) => Boolean(item.vectorPath || item.vectorBoolean));
  const hasVector = selected.some((item) => Boolean(item.vectorPath || item.vectorBoolean));
  const maskSources = selected.filter((item) => vectorMaskSource(item, document.nodes));
  const chosenMaskSource =
    maskSources.find((item) => item.id === maskSourceId) ?? maskSources.at(-1);
  function combinePaths(operation: VectorBoolean) {
    const id = crypto.randomUUID();
    onDocument(
      (content) =>
        createVectorBoolean(
          content,
          selected.map((n) => n.id),
          operation,
          id,
        ),
      id,
    );
  }
  function maskLayers() {
    if (!chosenMaskSource) return;
    const id = crypto.randomUUID();
    onDocument(
      (content) =>
        createVectorMask(
          content,
          selected.map((n) => n.id),
          chosenMaskSource.id,
          id,
        ),
      id,
    );
  }
  const image = selected.every(
    (item) =>
      !item.vectorPath && !item.vectorBoolean && (item.type === "image" || item.type === "vector"),
  );
  const common = <T,>(get: (node: DesignNode) => T) => shared(selected, get);
  const numberField = (
    label: string,
    get: (node: DesignNode) => number | undefined,
    patch: (value: number | undefined) => Patch,
    min?: number,
    max?: number,
    optional = false,
    step: number | "any" = "any",
  ) => (
    <PropertyField
      key={label}
      label={label}
      value={common(get)}
      numeric
      min={min}
      max={max}
      step={step}
      onCommit={(value) => {
        if (value !== "" || optional) onPatch(patch(value === "" ? undefined : Number(value)));
      }}
    />
  );
  const styleNumber = (
    label: string,
    key: keyof DesignNode["style"],
    fallback: number,
    min: number,
    max: number,
  ) =>
    numberField(
      label,
      (item) => (item.style[key] as number | undefined) ?? fallback,
      (value) => ({ style: { [key]: value } }),
      min,
      max,
    );
  const radiusKeys = [
    "radiusTopLeft",
    "radiusTopRight",
    "radiusBottomRight",
    "radiusBottomLeft",
  ] as const;
  const paddingKeys = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;
  const borderKeys = [
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
  ] as const;
  const separateRadius = selected.some((item) =>
    radiusKeys.some((key) => item.style[key] !== undefined),
  );
  const separatePadding = selected.some((item) =>
    paddingKeys.some((key) => item[key] !== undefined),
  );
  const separateBorder = selected.some((item) =>
    borderKeys.some((key) => item.style[key] !== undefined),
  );
  const tokens = resolvedColorTokens(document);
  const tokenChoice = (label: string, key: "fillToken" | "colorToken" | "borderColorToken") =>
    Object.keys(tokens).length > 0 ? (
      <Choice
        label={label}
        value={common((item) => item.style[key] ?? "")}
        choices={[
          ["", "Custom"],
          ...Object.keys(tokens).map((name): [string, string] => [name, name]),
        ]}
        onChange={(value) => onPatch({ style: { [key]: value || undefined } })}
      />
    ) : null;

  if (!inspect && richSelection && selected.some((item) => item.id === richSelection.nodeId))
    return (
      <Section title="Text selection">
        <RichTextSelectionControls key={richSelection.nodeId} selection={richSelection} />
      </Section>
    );

  const inspectorHeader = (
    <>
      <div className="flex items-center gap-2 border-b border-primary-grey/60 px-4 py-3">
        <div className="min-w-0 flex-1">
          {multi ? (
            <p className="text-xs font-medium">{selected.length} layers</p>
          ) : inspect ? (
            <p className="truncate text-xs font-medium">{node.name}</p>
          ) : (
            <PropertyField
              disabled={readOnly}
              label="Layer name"
              value={node.name}
              onCommit={(name) => {
                if (name.trim()) onPatch({ name: name.trim() });
              }}
            />
          )}
        </div>
        {onClose && (
          <button
            type="button"
            aria-label="Close inspector"
            onClick={onClose}
            className={buttonClass}
          >
            ×
          </button>
        )}
      </div>
    </>
  );
  const exportOptions = (
    <ExportControls
      selected={sourceSelection}
      onExport={onExport}
      pending={exportPending}
      warnings={exportWarnings}
    />
  );

  const componentControls = (family || instance) && (
    <Section title="Component">
      {family && !inspect && (
        <div onKeyDown={(event) => event.stopPropagation()}>
          <SelectMenu
            label="Variant"
            value={node.variant ?? family.variants.default}
            disabled={readOnly}
            options={Object.keys(family.variants.options).map((name) => ({
              value: name,
              label: name,
            }))}
            onChange={(variant) => onPatch({ variant })}
          />
        </div>
      )}
      {instance && (
        <InstanceControls
          node={node}
          document={document}
          readOnly={inspect}
          onDocument={onDocument}
          onGoToMaster={onGoToMaster}
        />
      )}
    </Section>
  );
  if (inspect)
    return (
      <div>
        {inspectorHeader}
        {componentControls}
        <HandoffInspector selected={sourceSelection} document={document} viewport={viewport} />
        {exportOptions}
      </div>
    );

  return (
    <div>
      {inspectorHeader}
      {componentControls}
      <fieldset disabled={readOnly} className="min-w-0">
        {!multi &&
          node.vectorPath?.shape &&
          (node.vectorPath.shape.kind === "polygon" || node.vectorPath.shape.kind === "star") && (
            <Section title={node.vectorPath.shape.kind === "star" ? "Star" : "Polygon"}>
              {numberField(
                "Points",
                (item) =>
                  item.vectorPath?.shape?.points ??
                  (item.vectorPath?.shape?.kind === "star" ? 5 : 3),
                (points) => ({
                  vectorPath: nativeShapePath(
                    { ...node.vectorPath!.shape!, points },
                    node.vectorPath!.viewBox,
                  ),
                }),
                3,
                64,
                false,
                1,
              )}
              {node.vectorPath.shape.kind === "star" &&
                numberField(
                  "Inner radius (%)",
                  (item) => (item.vectorPath?.shape?.innerRadius ?? 0.5) * 100,
                  (value) => ({
                    vectorPath: nativeShapePath(
                      { ...node.vectorPath!.shape!, innerRadius: (value ?? 50) / 100 },
                      node.vectorPath!.viewBox,
                    ),
                  }),
                  1,
                  100,
                )}
            </Section>
          )}
        <TokenBindings selected={selected} document={document} onPatch={onPatch} />
        {!multi && vector && onEditVector && !readOnly && (
          <Section title="Path">
            <button type="button" className={buttonClass} onClick={onEditVector}>
              {editingVector ? "Finish editing points" : "Edit points"}
            </button>
          </Section>
        )}
        {multi && selected.every(vectorOperand) && !readOnly && (
          <Section title="Combine paths">
            <div className="grid grid-cols-2 gap-1.5">
              {(["union", "subtract", "intersect", "exclude"] as const).map((operation) => (
                <button
                  key={operation}
                  type="button"
                  className={buttonClass}
                  onClick={() => combinePaths(operation)}
                >
                  {operation[0].toUpperCase() + operation.slice(1)}
                </button>
              ))}
            </div>
          </Section>
        )}
        {multi && chosenMaskSource && !readOnly && (
          <Section title="Mask">
            <SelectMenu
              label="Mask source"
              value={chosenMaskSource.id}
              options={maskSources.map((n) => ({ value: n.id, label: n.name }))}
              onChange={setMaskSourceId}
            />
            <button type="button" className={`${buttonClass} mt-2`} onClick={maskLayers}>
              Create mask
            </button>
          </Section>
        )}
        {!multi && node.vectorBoolean && (
          <Section title="Boolean">
            <Choice
              label="Operation"
              value={node.vectorBoolean}
              choices={[
                ["union", "Union"],
                ["subtract", "Subtract"],
                ["intersect", "Intersect"],
                ["exclude", "Exclude"],
              ]}
              onChange={(value) => onPatch({ vectorBoolean: value as VectorBoolean })}
            />
            <button
              type="button"
              className={`${buttonClass} mt-2`}
              onClick={() => onDocument((content) => releaseVectorComposite(content, node.id))}
            >
              Release boolean
            </button>
          </Section>
        )}
        {!multi && node.mask && (
          <Section title="Mask">
            <SelectMenu
              label="Mask source"
              value={node.mask.sourceId}
              options={document.nodes
                .filter((n) => n.parentId === node.id && vectorMaskSource(n, document.nodes))
                .map((n) => ({ value: n.id, label: n.name }))}
              onChange={(sourceId) => onPatch({ mask: { ...node.mask!, sourceId } })}
            />
            <Choice
              label="Mask mode"
              value={node.mask.mode}
              choices={[
                ["alpha", "Alpha"],
                ["luminance", "Luminance"],
              ]}
              onChange={(value) =>
                onPatch({ mask: { ...node.mask!, mode: value as "alpha" | "luminance" } })
              }
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className={buttonClass}
                onClick={() => onPatch({ mask: { ...node.mask!, enabled: !node.mask!.enabled } })}
              >
                {node.mask.enabled ? "Disable mask" : "Enable mask"}
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => onDocument((content) => releaseVectorComposite(content, node.id))}
              >
                Release mask
              </button>
            </div>
          </Section>
        )}
        {!multi && (
          <ComponentPropertiesInspector
            key={`properties:${node.id}`}
            node={node}
            document={document}
            onDocument={onDocument}
          />
        )}
        <ReusableStylesInspector
          key={`styles:${selected.map((n) => n.id).join(",")}`}
          selected={sourceSelection}
          document={document}
          onDocument={onDocument}
        />
        <Section title="Position">
          {selected.every((item) => item.type === "artboard") && (
            <Choice
              label="Frame preset"
              value={common(
                (item) =>
                  framePresets.find(
                    (preset) =>
                      preset.width === item.box.width && preset.height === item.box.height,
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
          <div className="grid grid-cols-3 gap-1.5">
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
            {styleNumber("Rotation", "rotation", 0, -360, 360)}
          </div>
          <div className="grid grid-cols-[1fr_1fr_32px] items-end gap-1.5">
            {(["width", "height"] as const).map((axis) =>
              numberField(
                axis === "width" ? "Width" : "Height",
                (item) => item.box[axis],
                (value) => (item) => {
                  const other = axis === "width" ? "height" : "width";
                  return {
                    box: {
                      [axis]: value,
                      ...(item.aspectRatioLocked && value
                        ? {
                            [other]: Math.max(
                              1,
                              Math.min(5000, (item.box[other] * value) / item.box[axis]),
                            ),
                          }
                        : {}),
                    },
                    [axis === "width" ? "widthMode" : "heightMode"]: "fixed",
                  };
                },
                1,
                5000,
              ),
            )}
            <button
              type="button"
              aria-label="Lock aspect ratio"
              aria-pressed={common((item) => item.aspectRatioLocked ?? false) ?? false}
              onClick={() =>
                onPatch({ aspectRatioLocked: !common((item) => item.aspectRatioLocked ?? false) })
              }
              className={`${buttonClass} h-8 px-1`}
            >
              {common((item) => item.aspectRatioLocked ?? false) ? "↔" : "⌁"}
            </button>
          </div>
          {!text && (
            <div className="grid grid-cols-2 gap-1.5">
              {(["widthMode", "heightMode"] as const).map((key) => (
                <Choice
                  key={key}
                  label={key === "widthMode" ? "Width sizing" : "Height sizing"}
                  value={common((item) => item[key] ?? "fixed")}
                  choices={
                    selected.some((item) => item.vectorBoolean || item.mask)
                      ? [["fixed", "Fixed"]]
                      : [
                          ["fixed", "Fixed"],
                          ["fill", "Fill"],
                          ["hug", "Hug"],
                        ]
                  }
                  onChange={(value) => onPatch({ [key]: value })}
                />
              ))}
            </div>
          )}
          {onScale && selected.every((item) => item.parentId === node.parentId) && (
            <PropertyField
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
          )}
          {selected.every(
            (item) =>
              item.parentId &&
              (item.positionMode === "absolute" || parentLayout(item) === "absolute"),
          ) && (
            <div className="grid grid-cols-2 gap-1.5">
              <Choice
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
                    horizontalConstraint: value as DesignNode["horizontalConstraint"],
                    widthMode: "fixed",
                  })
                }
              />
              <Choice
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
                    verticalConstraint: value as DesignNode["verticalConstraint"],
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
                type="button"
                className={buttonClass}
                onClick={() => onDistribute("horizontal")}
              >
                Distribute H
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => onDistribute("vertical")}
              >
                Distribute V
              </button>
            </div>
          )}
        </Section>
        {containers && (
          <Section title="Layout">
            <Choice
              label="Flow"
              value={common((item) => item.layout)}
              choices={[
                ["absolute", "Free position"],
                ["flex-row", "Horizontal"],
                ["flex-column", "Vertical"],
                ["grid", "Grid"],
              ]}
              onChange={(value) =>
                onPatch((item) => ({
                  layout: value as DesignNode["layout"],
                  ...(value === "grid" && (item.gap ?? 0) < 0 ? { gap: 0 } : {}),
                }))
              }
            />
            {selected.some((item) => item.layout !== "absolute") && (
              <>
                {numberField(
                  "Gap",
                  (item) => item.gap ?? 0,
                  (value) => ({ gap: value, columnGap: undefined, rowGap: undefined }),
                  selected.some((item) => item.layout === "grid" || item.wrap) ? 0 : -1000,
                  1000,
                )}
                <div className="grid grid-cols-2 gap-1.5">
                  <Choice
                    label="Align"
                    value={common((item) => item.align ?? "start")}
                    choices={[
                      ["start", "Start"],
                      ["center", "Center"],
                      ["end", "End"],
                      ["stretch", "Stretch"],
                      ["baseline", "Baseline"],
                    ]}
                    onChange={(value) => onPatch({ align: value as DesignNode["align"] })}
                  />
                  <Choice
                    label="Distribute"
                    value={common((item) => item.justify ?? "start")}
                    choices={[
                      ["start", "Start"],
                      ["center", "Center"],
                      ["end", "End"],
                      ["space-between", "Space between"],
                    ]}
                    onChange={(value) => onPatch({ justify: value as DesignNode["justify"] })}
                  />
                </div>
                {selected.some((item) => item.layout === "grid" || item.wrap) && (
                  <div className="grid grid-cols-2 gap-1.5">
                    {numberField(
                      "Column gap",
                      (item) => item.columnGap ?? Math.max(0, item.gap ?? 0),
                      (value) => ({ columnGap: value }),
                      0,
                      1000,
                    )}
                    {numberField(
                      "Row gap",
                      (item) => item.rowGap ?? Math.max(0, item.gap ?? 0),
                      (value) => ({ rowGap: value }),
                      0,
                      1000,
                    )}
                  </div>
                )}
                {selected.every((item) => item.layout === "grid") ? (
                  numberField(
                    "Columns",
                    (item) => item.gridColumnTracks?.length ?? item.gridColumns ?? 2,
                    (value) => (item) => ({
                      gridColumns: value,
                      gridColumnTracks:
                        item.gridColumnTracks && value
                          ? Array.from(
                              { length: value },
                              (_, index) =>
                                item.gridColumnTracks?.[index] ?? { unit: "fr" as const, value: 1 },
                            )
                          : undefined,
                    }),
                    1,
                    12,
                  )
                ) : (
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={common((item) => item.wrap ?? false) ?? false}
                      onChange={(event) => {
                        const wrap = event.target.checked;
                        onPatch((item) => ({
                          wrap,
                          ...(wrap && (item.gap ?? 0) < 0 ? { gap: 0 } : {}),
                        }));
                      }}
                    />
                    Wrap
                  </label>
                )}
                {!multi && node.layout === "grid" && (
                  <details className="rounded-md border border-primary-grey/70 px-2 py-1.5 text-xs">
                    <summary className="cursor-pointer">Grid tracks</summary>
                    <div className="mt-2 space-y-2">
                      {columnTracks(node).map((track, index) => (
                        <div key={`column-${index}`} className="grid grid-cols-2 items-end gap-1.5">
                          <Choice
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
                                    : { unit: unit as "fr" | "px", value: unit === "fr" ? 1 : 100 },
                                ),
                              )
                            }
                          />
                          {track.unit !== "auto" && (
                            <PropertyField
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
                        <div
                          key={`row-${index}`}
                          className="grid grid-cols-[1fr_1fr_28px] items-end gap-1.5"
                        >
                          <Choice
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
                                    : { unit: unit as "fr" | "px", value: unit === "fr" ? 1 : 100 },
                                ),
                              )
                            }
                          />
                          {track.unit !== "auto" && (
                            <PropertyField
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
                            type="button"
                            aria-label={`Remove row ${index + 1} track`}
                            className={buttonClass}
                            onClick={() =>
                              onPatch((item) => {
                                const tracks = item.gridRowTracks?.filter(
                                  (_, position) => position !== index,
                                );
                                return { gridRowTracks: tracks?.length ? tracks : undefined };
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
                )}
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-secondary-ink">Padding</span>
                  <button
                    type="button"
                    aria-label="Independent padding"
                    aria-pressed={separatePadding}
                    className={buttonClass}
                    onClick={() =>
                      onPatch((item) =>
                        separatePadding
                          ? {
                              padding: item.paddingTop ?? item.padding ?? 0,
                              paddingTop: undefined,
                              paddingRight: undefined,
                              paddingBottom: undefined,
                              paddingLeft: undefined,
                            }
                          : {
                              paddingTop: item.padding ?? 0,
                              paddingRight: item.padding ?? 0,
                              paddingBottom: item.padding ?? 0,
                              paddingLeft: item.padding ?? 0,
                            },
                      )
                    }
                  >
                    {separatePadding ? "Link sides" : "Each side"}
                  </button>
                </div>
                {separatePadding ? (
                  <div className="grid grid-cols-2 gap-1.5">
                    {paddingKeys.map((key, index) =>
                      numberField(
                        ["Padding top", "Padding right", "Padding bottom", "Padding left"][index],
                        (item) => item[key] ?? item.padding ?? 0,
                        (value) => ({ [key]: value }),
                        0,
                        1000,
                      ),
                    )}
                  </div>
                ) : (
                  numberField(
                    "Padding",
                    (item) => item.padding ?? 0,
                    (value) => ({ padding: value }),
                    0,
                    1000,
                  )
                )}
              </>
            )}
            <Choice
              label="Overflow"
              value={common(
                (item) => item.style.overflow ?? (item.type === "artboard" ? "hidden" : "visible"),
              )}
              choices={[
                ["visible", "Visible"],
                ["hidden", "Clip"],
                ["auto", "Scroll"],
              ]}
              onChange={(value) =>
                onPatch({ style: { overflow: value as DesignNode["style"]["overflow"] } })
              }
            />
          </Section>
        )}
        {!multi && (
          <div className="px-4 py-3">
            <ResponsiveBreakpoints node={node} document={document} onPatch={onPatch} />
          </div>
        )}
        {!hasVector && (
          <Section
            title="Corners"
            action={
              <button
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
            ) : (
              styleNumber("Radius", "radius", 0, 0, 5000)
            )}
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
        {text && (
          <Section title="Text">
            {!multi && (
              <PropertyField
                label="Content"
                value={node.text ?? ""}
                multiline
                onCommit={(value) => onPatch({ text: value })}
              />
            )}
            <FontPicker selected={selected} onPatch={onPatch} />
            <div className="grid grid-cols-2 gap-1.5">
              {(["widthMode", "heightMode"] as const).map((key) => (
                <Choice
                  key={key}
                  label={key === "widthMode" ? "Text width" : "Text height"}
                  value={common((item) => item[key] ?? "fixed")}
                  choices={[
                    ["fixed", "Fixed"],
                    ["hug", key === "widthMode" ? "Auto width" : "Auto height"],
                    ["fill", "Fill"],
                  ]}
                  onChange={(value) => onPatch({ [key]: value })}
                />
              ))}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {styleNumber("Font size", "fontSize", 16, 6, 300)}
              {styleNumber("Letter spacing", "letterSpacing", 0, -100, 100)}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Choice
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
              {selected.some((item) => lineHeightMode(item) !== "auto") &&
                (common(lineHeightMode) === "px"
                  ? numberField(
                      "Line height px",
                      (item) => item.style.lineHeightPx ?? lineHeightPx(item),
                      (value) => ({ style: { lineHeightMode: "px", lineHeightPx: value } }),
                      0.1,
                      1200,
                    )
                  : numberField(
                      "Line height %",
                      (item) =>
                        item.style.lineHeightMode === "auto"
                          ? undefined
                          : (item.style.lineHeight ?? 1.35) * 100,
                      (value) => ({
                        style: {
                          lineHeightMode: "percent",
                          lineHeight: value === undefined ? undefined : value / 100,
                        },
                      }),
                      0.01,
                      20000,
                    ))}
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
                label="Vertical align"
                value={common((item) => item.style.textVerticalAlign ?? "top")}
                choices={[
                  ["top", "Top"],
                  ["center", "Middle"],
                  ["bottom", "Bottom"],
                ]}
                onChange={(value) =>
                  onPatch({
                    style: { textVerticalAlign: value as DesignNode["style"]["textVerticalAlign"] },
                  })
                }
              />
            )}
            <div className="flex gap-1.5">
              {["underline", "line-through"].map((decoration) => (
                <button
                  key={decoration}
                  type="button"
                  aria-pressed={common((item) => item.style.textDecoration === decoration) ?? false}
                  className={buttonClass}
                  onClick={() =>
                    onPatch({
                      style: {
                        textDecoration: common((item) => item.style.textDecoration === decoration)
                          ? "none"
                          : (decoration as DesignNode["style"]["textDecoration"]),
                      },
                    })
                  }
                >
                  {decoration === "underline" ? "Underline" : "Strike"}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Choice
                label="Text align"
                value={common((item) => item.style.textAlign ?? "left")}
                choices={[
                  ["left", "Left"],
                  ["center", "Center"],
                  ["right", "Right"],
                ]}
                onChange={(value) =>
                  onPatch({ style: { textAlign: value as DesignNode["style"]["textAlign"] } })
                }
              />
              <Choice
                label="Text case"
                value={common((item) => item.style.textCase ?? "none")}
                choices={[
                  ["none", "Original"],
                  ["uppercase", "UPPERCASE"],
                  ["lowercase", "lowercase"],
                  ["capitalize", "Title Case"],
                ]}
                onChange={(value) =>
                  onPatch({ style: { textCase: value as DesignNode["style"]["textCase"] } })
                }
              />
            </div>
            <Choice
              label="Text wrapping"
              value={common((item) => item.style.textWrap ?? "wrap")}
              choices={[
                ["wrap", "Wrap"],
                ["nowrap", "Single line"],
              ]}
              onChange={(value) =>
                onPatch({ style: { textWrap: value as DesignNode["style"]["textWrap"] } })
              }
            />
            {selected.every((item) => item.style.textWrap === "nowrap") && (
              <Choice
                label="Truncation"
                value={common((item) => item.style.textOverflow ?? "clip")}
                choices={[
                  ["clip", "Clip"],
                  ["ellipsis", "Ellipsis"],
                ]}
                onChange={(value) =>
                  onPatch({ style: { textOverflow: value as DesignNode["style"]["textOverflow"] } })
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
            <ColorField
              label="Text color"
              nodes={selected}
              tokens={tokens}
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
          </Section>
        )}
        {image && (
          <Section title="Image">
            <Choice
              label="Image fit"
              value={common((item) => item.style.objectFit ?? "contain")}
              choices={[
                ["contain", "Fit"],
                ["cover", "Fill"],
                ["fill", "Stretch"],
              ]}
              onChange={(value) =>
                onPatch({ style: { objectFit: value as DesignNode["style"]["objectFit"] } })
              }
            />
            {!node.style.imageCrop && (
              <>
                <div className="grid grid-cols-2 gap-1.5">
                  {styleNumber("Image X %", "objectPositionX", 50, 0, 100)}
                  {styleNumber("Image Y %", "objectPositionY", 50, 0, 100)}
                </div>
                {styleNumber("Image scale", "objectScale", 1, 1, 10)}
              </>
            )}
            {!multi && onCropImage && (
              <button
                type="button"
                aria-pressed={cropping}
                onClick={onCropImage}
                className={buttonClass}
              >
                {cropping ? "Finish crop" : "Crop image"}
              </button>
            )}
            {selected.every((item) => item.style.imageCrop) && (
              <div className="flex gap-1.5">
                {[
                  [1 / 1.1, "Zoom image out"],
                  [1.1, "Zoom image in"],
                ].map(([factor, label]) => (
                  <button
                    key={label}
                    type="button"
                    className={buttonClass}
                    onClick={() =>
                      onPatch((item) => ({
                        style: { imageCrop: zoomImageCrop(item.style.imageCrop!, Number(factor)) },
                      }))
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {selected.some((item) => item.style.imageCrop) && (
              <button
                type="button"
                onClick={() =>
                  onPatch({
                    style: {
                      imageCrop: undefined,
                      objectScale: 1,
                      objectPositionX: 50,
                      objectPositionY: 50,
                    },
                  })
                }
                className={buttonClass}
              >
                Reset crop
              </button>
            )}
            {!multi && (
              <button type="button" onClick={onReplaceImage} className={buttonClass}>
                Replace image
              </button>
            )}
          </Section>
        )}
        <FillInspector
          selected={selected}
          tokens={tokens}
          onPatch={onPatch}
          onUpload={hasVector ? undefined : onUploadFill}
          editingGradientId={editingGradientId}
          onGradientEdit={hasVector ? undefined : onGradientEdit}
          viewport={viewport}
        />
        <FillInspector
          mode="stroke"
          selected={selected}
          tokens={tokens}
          onPatch={onPatch}
          viewport={viewport}
        >
          {!hasVector && (
            <button
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
                  label="Stroke position"
                  value={common((item) => item.style.strokePosition ?? "inside")}
                  choices={[
                    ["inside", "Inside"],
                    ["center", "Center"],
                    ["outside", "Outside"],
                  ]}
                  onChange={(value) =>
                    onPatch({
                      style: { strokePosition: value as DesignNode["style"]["strokePosition"] },
                    })
                  }
                />
              )}
              {vector && (
                <>
                  <Choice
                    label="Line cap"
                    value={common((item) => item.style.strokeCap ?? "butt")}
                    choices={[
                      ["butt", "Butt"],
                      ["round", "Round"],
                      ["square", "Square"],
                    ]}
                    onChange={(value) =>
                      onPatch({ style: { strokeCap: value as DesignNode["style"]["strokeCap"] } })
                    }
                  />
                  <Choice
                    label="Line join"
                    value={common((item) => item.style.strokeJoin ?? "miter")}
                    choices={[
                      ["miter", "Miter"],
                      ["round", "Round"],
                      ["bevel", "Bevel"],
                    ]}
                    onChange={(value) =>
                      onPatch({ style: { strokeJoin: value as DesignNode["style"]["strokeJoin"] } })
                    }
                  />
                  {selected.every(
                    (item) => item.vectorPath && !/[zZ]\s*$/.test(item.vectorPath.d),
                  ) &&
                    (["strokeStart", "strokeEnd"] as const).map((key) => (
                      <Choice
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
                label="Border style"
                value={common((item) => item.style.borderStyle ?? "solid")}
                choices={[
                  ["solid", "Solid"],
                  ["dashed", "Dashed"],
                  ["dotted", "Dotted"],
                ]}
                onChange={(value) =>
                  onPatch({ style: { borderStyle: value as DesignNode["style"]["borderStyle"] } })
                }
              />
            </>
          )}
        </FillInspector>
        <Section title="Appearance">
          {numberField(
            "Opacity %",
            (item) => Math.round((item.style.opacity ?? 1) * 100),
            (value) => ({ style: { opacity: value! / 100 } }),
            0,
            100,
          )}
          <Choice
            label="Blend mode"
            value={common((item) => item.style.blendMode ?? "normal")}
            choices={["normal", "multiply", "screen", "overlay", "darken", "lighten"].map(
              (mode) => [mode, mode],
            )}
            onChange={(value) =>
              onPatch({ style: { blendMode: value as DesignNode["style"]["blendMode"] } })
            }
          />
        </Section>
        <EffectsInspector selected={selected} tokens={tokens} onPatch={onPatch} />
        <details className="border-b border-primary-grey/60">
          <summary className="cursor-pointer px-4 py-3 text-xs font-medium">Outline</summary>
          <div className="space-y-2 px-4 pb-3">
            {styleNumber("Outline width", "outlineWidth", 0, 0, 40)}
            <ColorField
              label="Outline color"
              nodes={selected}
              tokens={tokens}
              get={(item) => item.style.outlineColor ?? "#000000"}
              onChange={(value) =>
                onPatch((item) => ({
                  style: { outlineColor: applyColor(value, item.style.outlineColor ?? "#000000") },
                }))
              }
            />
          </div>
        </details>
        <details className="border-b border-primary-grey/60">
          <summary className="cursor-pointer px-4 py-3 text-xs font-medium">Sizing limits</summary>
          <div className="grid grid-cols-2 gap-1.5 px-4 pb-3">
            {(["minWidth", "maxWidth", "minHeight", "maxHeight"] as const).map((key) =>
              numberField(
                key.replace(/([A-Z])/g, " $1"),
                (item) => item[key],
                (value) => ({ [key]: value }),
                key.startsWith("max") ? 1 : 0,
                5000,
                true,
              ),
            )}
          </div>
        </details>
        {!multi && node.type !== "artboard" && (
          <Section title="Structure">
            <Choice
              label="Parent"
              value={node.parentId ?? ""}
              choices={[
                ["", "Canvas"],
                ...document.nodes
                  .filter(
                    (item) =>
                      ["artboard", "container"].includes(item.type) &&
                      item.id !== node.id &&
                      (item.pageId ?? "page-1") === (node.pageId ?? "page-1"),
                  )
                  .map((item): [string, string] => [item.id, item.name]),
              ]}
              onChange={(parentId) =>
                onDocument((content) =>
                  reparentLayer(
                    content,
                    node.id,
                    parentId || null,
                    new Map(
                      [...canvasElements(viewport?.current).values()].map((element) => [
                        element.dataset.nodeId!,
                        renderedNodeBox(element),
                      ]),
                    ),
                  ),
                )
              }
            />
            <Choice
              label="Position in layout"
              value={node.positionMode ?? "auto"}
              choices={[
                ["auto", "In flow"],
                ["absolute", "Absolute"],
              ]}
              onChange={(value) => onPatch({ positionMode: value as DesignNode["positionMode"] })}
            />
            <Choice
              label="Self alignment"
              value={node.alignSelf ?? "auto"}
              choices={[
                ["auto", "Parent default"],
                ["start", "Start"],
                ["center", "Center"],
                ["end", "End"],
                ["stretch", "Stretch"],
                ["baseline", "Baseline"],
              ]}
              onChange={(value) => onPatch({ alignSelf: value as DesignNode["alignSelf"] })}
            />
          </Section>
        )}
        {multi && (
          <div className="p-4">
            <button type="button" className={buttonClass} onClick={onGroup}>
              Group selection
            </button>
          </div>
        )}
      </fieldset>
      {exportOptions}
    </div>
  );
});
