import type { DesignNode } from "./document";
import { rotatePoint } from "./resize-box";
import { imageViewport } from "./image-viewport";
export type ImageCrop = NonNullable<DesignNode["style"]["imageCrop"]>;
type Box = DesignNode["box"];
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
/** Placeholder dimensions must never become persisted source crop geometry. */
export function loadedImageSize(
  image:
    | Pick<HTMLImageElement, "complete" | "naturalWidth" | "naturalHeight" | "dataset">
    | null
    | undefined,
) {
  if (
    !image?.complete ||
    image.dataset.imageLoading ||
    image.dataset.imageFailed ||
    !image.naturalWidth ||
    !image.naturalHeight
  )
    return undefined;
  return { width: image.naturalWidth, height: image.naturalHeight };
}
/** Capture the visible source rectangle of a cover image, including focal point/zoom. */
export function initialImageCrop(
  node: DesignNode,
  box: Box,
  sourceWidth: number,
  sourceHeight: number,
  fill = false,
): ImageCrop {
  box = imageViewport(node, box, fill);
  const source = node.style.imageCrop ?? {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    sourceWidth,
    sourceHeight,
  };
  const regionWidth = source.width * source.sourceWidth,
    regionHeight = source.height * source.sourceHeight;
  const factor =
    Math.max(box.width / regionWidth, box.height / regionHeight) *
    (node.style.imageCrop ? 1 : (node.style.objectScale ?? 1));
  const width = Math.min(1, box.width / (regionWidth * factor)),
    height = Math.min(1, box.height / (regionHeight * factor));
  const x = node.style.imageCrop ? 50 : (node.style.objectPositionX ?? 50),
    y = node.style.imageCrop ? 50 : (node.style.objectPositionY ?? 50);
  return {
    ...source,
    x: source.x + (((1 - width) * x) / 100) * source.width,
    y: source.y + (((1 - height) * y) / 100) * source.height,
    width: width * source.width,
    height: height * source.height,
  };
}
export function panImageCrop(crop: ImageCrop, box: Box, delta: { x: number; y: number }) {
  return {
    ...crop,
    x: clamp(crop.x - (delta.x / box.width) * crop.width, 0, 1 - crop.width),
    y: clamp(crop.y - (delta.y / box.height) * crop.height, 0, 1 - crop.height),
  };
}
/** Crop handles move the mask while keeping the underlying image stationary. */
export function resizeImageCrop(node: DesignNode, before: Box, after: Box) {
  const saved = node.style.imageCrop!;
  const crop = initialImageCrop(node, before, saved.sourceWidth, saved.sourceHeight);
  const outerBefore = before;
  before = imageViewport(node, before);
  after = imageViewport(node, after);
  const center = rotatePoint(
    {
      x: after.x + after.width / 2 - before.x - before.width / 2,
      y: after.y + after.height / 2 - before.y - before.height / 2,
    },
    -(node.style.rotation ?? 0),
  );
  if (node.style.flipX) center.x *= -1;
  if (node.style.flipY) center.y *= -1;
  const sourceX = crop.width / before.width,
    sourceY = crop.height / before.height;
  const left = clamp(
    crop.x + (center.x + (before.width - after.width) / 2) * sourceX,
    0,
    1 - Math.max(0.000001, sourceX),
  );
  const top = clamp(
    crop.y + (center.y + (before.height - after.height) / 2) * sourceY,
    0,
    1 - Math.max(0.000001, sourceY),
  );
  const right = clamp(
    crop.x + (center.x + (before.width + after.width) / 2) * sourceX,
    left + Math.max(0.000001, sourceX),
    1,
  );
  const bottom = clamp(
    crop.y + (center.y + (before.height + after.height) / 2) * sourceY,
    top + Math.max(0.000001, sourceY),
    1,
  );
  const width = (right - left) / sourceX,
    height = (bottom - top) / sourceY;
  const shift = {
    x: (left - crop.x) / sourceX + (width - before.width) / 2,
    y: (top - crop.y) / sourceY + (height - before.height) / 2,
  };
  if (node.style.flipX) shift.x *= -1;
  if (node.style.flipY) shift.y *= -1;
  const parentShift = rotatePoint(shift, node.style.rotation ?? 0);
  const horizontalInset = outerBefore.width - before.width;
  const verticalInset = outerBefore.height - before.height;
  return {
    box: {
      x: outerBefore.x + outerBefore.width / 2 + parentShift.x - (width + horizontalInset) / 2,
      y: outerBefore.y + outerBefore.height / 2 + parentShift.y - (height + verticalInset) / 2,
      width: width + horizontalInset,
      height: height + verticalInset,
    },
    crop: { ...crop, x: left, y: top, width: right - left, height: bottom - top },
  };
}
export function zoomImageCrop(crop: ImageCrop, factor: number) {
  const scale = clamp(
    factor,
    Math.max(crop.width, crop.height),
    Math.min(crop.width, crop.height) / 0.000001,
  );
  const width = crop.width / scale,
    height = crop.height / scale;
  return {
    ...crop,
    x: clamp(crop.x + (crop.width - width) / 2, 0, 1 - width),
    y: clamp(crop.y + (crop.height - height) / 2, 0, 1 - height),
    width,
    height,
  };
}
