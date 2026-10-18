import type { DesignNode } from "./document";
import { imageViewport } from "./image-viewport";
import { rotatePoint } from "./resize-box";

/** Scale both axes together, including when one reaches a document size limit. */
export function proportionalImageSize(
  box: DesignNode["box"],
  axis: "width" | "height",
  value: number,
) {
  const scale = Math.max(
    1 / Math.min(box.width, box.height),
    Math.min(5000 / Math.max(box.width, box.height), value / box[axis]),
  );
  return { width: box.width * scale, height: box.height * scale };
}

/** Remove contain letterboxing without moving or rescaling the visible pixels. */
export function fitImageBounds(node: DesignNode, sourceWidth: number, sourceHeight: number) {
  if (
    (node.style.objectFit ?? "contain") !== "contain" ||
    (!node.style.imageCrop && (node.style.objectScale ?? 1) !== 1)
  )
    throw new Error("Set Image fit to Fit and Image scale to 1 before fitting the bounds.");
  const box = node.box;
  const viewport = imageViewport(node);
  const crop = node.style.imageCrop;
  const width = crop ? crop.width * crop.sourceWidth : sourceWidth;
  const height = crop ? crop.height * crop.sourceHeight : sourceHeight;
  if (!(width > 0 && height > 0)) throw new Error("Wait for the image to finish loading.");
  const scale = Math.min(viewport.width / width, viewport.height / height);
  const nextWidth = width * scale;
  const nextHeight = height * scale;
  const removedX = viewport.width - nextWidth;
  const removedY = viewport.height - nextHeight;
  const x = crop ? 0.5 : (node.style.objectPositionX ?? 50) / 100;
  const y = crop ? 0.5 : (node.style.objectPositionY ?? 50) / 100;
  const shift = rotatePoint(
    {
      x: removedX * (x - 0.5) * (node.style.flipX ? -1 : 1),
      y: removedY * (y - 0.5) * (node.style.flipY ? -1 : 1),
    },
    node.style.rotation ?? 0,
  );
  return {
    x: box.x + removedX / 2 + shift.x,
    y: box.y + removedY / 2 + shift.y,
    width: box.width - removedX,
    height: box.height - removedY,
  };
}
