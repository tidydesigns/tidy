import type { DesignNode, DesignNodeChanges as NodeChanges } from "./document";
import type { ImageAdjustments } from "@bella/design/image-adjustments";
export type ImageEditTarget = { nodeId: string; paintId?: string };
export function imageEditNode(node: DesignNode, target: ImageEditTarget): DesignNode | undefined {
  if (node.id !== target.nodeId || node.vectorPath || node.vectorBoolean) return;
  if (!target.paintId) return node.assetId ? node : undefined;
  const paint = node.style.paints?.find((paint) => paint.id === target.paintId);
  if (paint?.type !== "image" || !paint.assetId) return;
  return {
    ...node,
    type: "image",
    assetId: paint.assetId,
    style: {
      objectFit: paint.fit,
      objectPositionX: paint.positionX,
      objectPositionY: paint.positionY,
      imageCrop: paint.crop,
      imageAdjustments: paint.adjustments,
    },
  };
}
export type ImageEdit = { adjustments?: ImageAdjustments; fit?: "cover" | "contain" | "fill" };
/** Resolve paint identity against the latest node, preserving unrelated/concurrent properties. */
export function imageEditChanges(
  node: DesignNode,
  target: ImageEditTarget,
  edit: ImageEdit,
): NodeChanges {
  if (!imageEditNode(node, target)) return {};
  if (!target.paintId)
    return {
      style: {
        ...(edit.adjustments
          ? { imageAdjustments: { ...node.style.imageAdjustments, ...edit.adjustments } }
          : {}),
        ...(edit.fit ? { objectFit: edit.fit, imageCrop: undefined, objectScale: 1 } : {}),
      },
    };
  return {
    style: {
      paints: node.style.paints!.map((paint) =>
        paint.id === target.paintId && paint.type === "image"
          ? {
              ...paint,
              ...(edit.adjustments
                ? { adjustments: { ...paint.adjustments, ...edit.adjustments } }
                : {}),
              ...(edit.fit ? { fit: edit.fit, crop: undefined } : {}),
            }
          : paint,
      ),
    },
  };
}
