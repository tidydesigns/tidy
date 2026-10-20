"use client";
import type { SelectionInspectorProps } from "./types";
import { selectionFields, inspectorButtonClass as buttonClass } from "./fields";
import { zoomImageCrop } from "../../design/image-crop";
import { Section, Choice } from "../inspector-controls";
import { InspectorDisclosure } from "../inspector-presentation";

type Props = Pick<
  SelectionInspectorProps,
  | "selected"
  | "onPatch"
  | "onEditImage"
  | "onFitImageBounds"
  | "onCropImage"
  | "onReplaceImage"
  | "cropping"
>;
export function ImageSection({
  selected,
  onPatch,
  onEditImage,
  onFitImageBounds,
  onCropImage,
  onReplaceImage,
  cropping,
}: Props) {
  const multi = selected.length > 1;
  const node = selected[0];
  const { common, styleNumber } = selectionFields(selected, onPatch);

  return (
    <Section replayTitle title="Image">
      {!multi && onEditImage && (
        <button data-ph-public type="button" className={buttonClass} onClick={() => onEditImage()}>
          Edit image
        </button>
      )}
      {
        <>
          <Choice
            replayOptions
            replayLabel
            label="Image fit"
            value={common((item) => item.style.objectFit ?? "contain")}
            choices={[
              ["contain", "Fit"],
              ["cover", "Fill"],
              ["fill", "Stretch"],
            ]}
            onChange={(value) => onPatch({ style: { objectFit: value } })}
          />
          {!node.style.imageCrop && (
            <InspectorDisclosure title="Image positioning" nested>
              <div className="grid grid-cols-2 gap-1.5">
                {styleNumber("Image X %", "objectPositionX", 50, 0, 100)}
                {styleNumber("Image Y %", "objectPositionY", 50, 0, 100)}
              </div>
              {styleNumber("Image scale", "objectScale", 1, 1, 10)}
            </InspectorDisclosure>
          )}
        </>
      }
      {!multi &&
        !cropping &&
        onFitImageBounds &&
        (node.style.objectFit ?? "contain") === "contain" &&
        (node.style.imageCrop || (node.style.objectScale ?? 1) === 1) && (
          <button data-ph-public type="button" onClick={onFitImageBounds} className={buttonClass}>
            Fit bounds to image
          </button>
        )}
      {!multi && onCropImage && (
        <button
          data-ph-public
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
                  style: {
                    imageCrop: zoomImageCrop(item.style.imageCrop!, Number(factor)),
                  },
                }))
              }
            >
              <span data-ph-public>{label}</span>
            </button>
          ))}
        </div>
      )}
      {selected.some((item) => item.style.imageCrop) && (
        <button
          data-ph-public
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
        <button data-ph-public type="button" onClick={onReplaceImage} className={buttonClass}>
          Replace image
        </button>
      )}
    </Section>
  );
}
