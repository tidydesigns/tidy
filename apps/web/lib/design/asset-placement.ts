import { isLayerLocked, isLayerVisible } from "./edit-document";
import { parseDesignDocument, type DesignDocument, type DesignNode } from "./document";
import { editLayers } from "./edit-document";
import { importSvgPath, inspectSvgImport } from "./svg-path-import";

export type PlacementTarget = { pageId: string; parentId: string | null; x: number; y: number };
export type PlacementAsset = {
  id: string;
  name: string;
  mimeType?: string;
  width: number;
  height: number;
  vector?: ReturnType<typeof importSvgPath>;
};
export function intrinsicSize(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error("Image dimensions are unavailable.");
  const factor = Math.min(1, 5000 / width, 5000 / height);
  return { width: Math.max(1, width * factor), height: Math.max(1, height * factor) };
}
export function validatePlacementTarget(document: DesignDocument, target: PlacementTarget) {
  if (!document.pages.some((page) => page.id === target.pageId))
    throw new Error("The destination page was removed.");
  if (target.parentId) {
    const parent = document.nodes.find((node) => node.id === target.parentId);
    if (
      !parent ||
      !["artboard", "container"].includes(parent.type) ||
      (parent.pageId ?? "page-1") !== target.pageId
    )
      throw new Error("The destination layer was removed or moved.");
    if (isLayerLocked(document.nodes, parent.id) || !isLayerVisible(document.nodes, parent.id))
      throw new Error("Unlock and show the destination before placing images.");
  }
}
/** Apply a completed batch to the latest document, preserving edits made during decoding/upload. */
export function placeAssets(
  document: DesignDocument,
  target: PlacementTarget,
  assets: PlacementAsset[],
  ids: string[],
) {
  validatePlacementTarget(document, target);
  if (
    assets.length !== ids.length ||
    new Set(ids).size !== ids.length ||
    document.nodes.some((node) => ids.includes(node.id))
  )
    throw new Error("Invalid placement identifiers.");
  const nodes = assets.map((asset, index): DesignNode => ({
    id: ids[index],
    parentId: target.parentId,
    pageId: target.pageId,
    name: asset.name.slice(0, 120) || "Image",
    type: asset.vector ? "vector" : "image",
    vectorPath: asset.vector?.vectorPath,
    box: {
      x: Math.max(-100000, Math.min(100000, target.x + index * 24)),
      y: Math.max(-100000, Math.min(100000, target.y + index * 24)),
      ...intrinsicSize(asset.width, asset.height),
    },
    style: asset.vector?.style ?? { objectFit: "contain" },
    assetId: asset.id,
    aspectRatioLocked: true,
    visible: true,
    locked: false,
    layout: "absolute",
  }));
  return parseDesignDocument({
    ...document,
    assetMimeTypes: {
      ...document.assetMimeTypes,
      ...Object.fromEntries(
        assets.filter((asset) => asset.mimeType).map((asset) => [asset.id, asset.mimeType!]),
      ),
    },
    nodes: [...document.nodes, ...nodes],
  });
}
export function replaceImageAsset(
  document: DesignDocument,
  nodeId: string,
  expectedAssetId: string | undefined,
  asset: PlacementAsset,
) {
  const node = document.nodes.find((node) => node.id === nodeId);
  if (!node || !["image", "vector"].includes(node.type) || isLayerLocked(document.nodes, nodeId))
    throw new Error("The replacement layer was removed, changed or locked.");
  if (node.assetId !== expectedAssetId)
    throw new Error("This image was replaced while the upload was in progress.");
  const updated = editLayers(document, [nodeId], {
    assetId: asset.id,
    style: { ...asset.vector?.style, imageCrop: undefined, objectScale: 1 },
  });
  return parseDesignDocument({
    ...updated,
    assetMimeTypes: asset.mimeType
      ? { ...updated.assetMimeTypes, [asset.id]: asset.mimeType }
      : updated.assetMimeTypes,
    nodes: updated.nodes.map((current) =>
      current.id === nodeId
        ? {
            ...current,
            type: asset.vector ? "vector" : "image",
            vectorPath: asset.vector?.vectorPath,
          }
        : current,
    ),
  });
}

export async function readImageFile(file: File) {
  if (
    !new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]).has(file.type) ||
    file.size > 2_000_000 ||
    !file.size
  )
    throw new Error("Choose a PNG, JPEG, WebP or SVG image under 2 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    intrinsicSize(image.naturalWidth, image.naturalHeight);
    const svg = file.type === "image/svg+xml" ? inspectSvgImport(await file.text()) : undefined;
    return {
      reason: svg?.reason,
      width: image.naturalWidth,
      height: image.naturalHeight,
      vector: svg?.editable,
    };
  } catch {
    throw new Error(`Could not decode ${file.name || "image"}.`);
  } finally {
    URL.revokeObjectURL(url);
  }
}
