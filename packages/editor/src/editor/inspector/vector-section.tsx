"use client";
import type { SelectionInspectorProps } from "./types";
import { useState } from "react";
import type { SelectionFeatures } from "./selection";
import { selectionFields, inspectorButtonClass as buttonClass } from "./fields";
import { nativeShapePath } from "@tidy/design/native-shapes";
import {
  vectorMaskSource,
  vectorMaskSources,
  vectorOperand,
} from "@tidy/design/vector-relationships";
import type { VectorBoolean } from "@tidy/design/vector-boolean";
import {
  createVectorBoolean,
  createVectorMask,
  releaseVectorComposite,
} from "../../design/vector-composite-operations";
import { Section, Choice } from "../inspector-controls";
import { SelectMenu } from "../../components/ui/select-menu";

type Props = Pick<
  SelectionInspectorProps,
  "selected" | "document" | "onPatch" | "onDocument" | "onEditVector" | "editingVector" | "readOnly"
> &
  Pick<SelectionFeatures, "vector">;

export function VectorSection({
  selected,
  document,
  onPatch,
  onDocument,
  onEditVector,
  editingVector,
  readOnly,
  vector,
}: Props) {
  const multi = selected.length > 1;
  const node = selected[0];
  const { numberField } = selectionFields(selected, onPatch);
  const [maskSourceId, setMaskSourceId] = useState("");
  const maskSources = vectorMaskSources(selected, document.nodes);
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

  return (
    <>
      {" "}
      {!multi &&
        node.vectorPath?.shape &&
        (node.vectorPath.shape.kind === "polygon" || node.vectorPath.shape.kind === "star") && (
          <Section replayTitle title={node.vectorPath.shape.kind === "star" ? "Star" : "Polygon"}>
            {numberField(
              "Points",
              (item) =>
                item.vectorPath?.shape?.points ?? (item.vectorPath?.shape?.kind === "star" ? 5 : 3),
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
      {!multi && vector && onEditVector && !readOnly && (
        <Section replayTitle title="Path">
          <button data-ph-public type="button" className={buttonClass} onClick={onEditVector}>
            {editingVector ? "Finish editing points" : "Edit points"}
          </button>
        </Section>
      )}
      {multi && selected.every(vectorOperand) && !readOnly && (
        <Section replayTitle title="Combine paths">
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
        <Section replayTitle title="Mask">
          <SelectMenu
            replayLabel
            label="Mask source"
            value={chosenMaskSource.id}
            options={maskSources.map((n) => ({ value: n.id, label: n.name }))}
            onChange={setMaskSourceId}
          />
          <button
            data-ph-public
            type="button"
            className={`${buttonClass} mt-2`}
            onClick={maskLayers}
          >
            Create mask
          </button>
        </Section>
      )}
      {!multi && node.vectorBoolean && (
        <Section replayTitle title="Boolean">
          <Choice
            replayOptions
            replayLabel
            label="Operation"
            value={node.vectorBoolean}
            choices={[
              ["union", "Union"],
              ["subtract", "Subtract"],
              ["intersect", "Intersect"],
              ["exclude", "Exclude"],
            ]}
            onChange={(value) => onPatch({ vectorBoolean: value })}
          />
          <button
            data-ph-public
            type="button"
            className={`${buttonClass} mt-2`}
            onClick={() => onDocument((content) => releaseVectorComposite(content, node.id))}
          >
            Release boolean
          </button>
        </Section>
      )}
      {!multi && node.mask && (
        <Section replayTitle title="Mask">
          <SelectMenu
            replayLabel
            label="Mask source"
            value={node.mask.sourceId}
            options={document.nodes
              .filter((n) => n.parentId === node.id && vectorMaskSource(n, document.nodes))
              .map((n) => ({ value: n.id, label: n.name }))}
            onChange={(sourceId) => onPatch({ mask: { ...node.mask!, sourceId } })}
          />
          <Choice
            replayOptions
            replayLabel
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
              data-ph-public
              type="button"
              className={buttonClass}
              onClick={() => onPatch({ mask: { ...node.mask!, enabled: !node.mask!.enabled } })}
            >
              {node.mask.enabled ? "Disable mask" : "Enable mask"}
            </button>
            <button
              data-ph-public
              type="button"
              className={buttonClass}
              onClick={() => onDocument((content) => releaseVectorComposite(content, node.id))}
            >
              Release mask
            </button>
          </div>
        </Section>
      )}
    </>
  );
}
