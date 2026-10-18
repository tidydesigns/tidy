"use client";
import { useEffect, useState } from "react";
import { displayImageUrl } from "@tidy/design-renderer/image-display";
import { createImagePool, type ImagePool } from "@tidy/design-renderer/image-loading";
import { useLoadedImage } from "@tidy/design-renderer/use-loaded-image";
import type { DesignDocument } from "../design/document";
import type { BrowserAsset } from "../design/asset-contract";
export type { BrowserAsset } from "../design/asset-contract";

function AssetThumbnail({ asset, pool }: { asset: BrowserAsset; pool: ImagePool }) {
  const original = asset.url ?? `/api/assets/${asset.assetId}`;
  // Small display variants never replace the original used for placement/export.
  const source = displayImageUrl(original, 256, asset.mimeType);
  const image = useLoadedImage(source, original, true, pool);
  return (
    <div className="flex h-12 w-full items-center justify-center" data-asset-thumbnail>
      {image.status === "ready" ? (
        <img src={image.url} alt="" className="h-full w-full object-contain" draggable={false} />
      ) : image.status === "failed" ? (
        <span
          data-ph-public
          data-ph-public-label
          className="text-secondary-ink"
          role="img"
          aria-label="Preview unavailable"
        >
          ×
        </span>
      ) : null}
    </div>
  );
}

export function AssetBrowser({
  assets,
  document,
  disabled,
  onPlace,
  more,
  onMore,
  loading,
  error,
}: {
  assets: BrowserAsset[];
  document: DesignDocument;
  disabled: boolean;
  onPlace: (asset: BrowserAsset) => void;
  more: boolean;
  onMore: () => void;
  loading: boolean;
  error: string;
}) {
  const [images] = useState(() => createImagePool());
  useEffect(() => () => images.clear(), [images]);
  if (!assets.length && !error) return null;
  const names = new Map<string, string>();
  for (const node of document.nodes) {
    if (node.assetId) names.set(node.assetId, node.name);
    for (const paint of node.style.paints ?? [])
      if (paint.type === "image" && paint.assetId) names.set(paint.assetId, node.name);
  }
  return (
    <details className="border-t border-primary-grey/60">
      <summary className="cursor-pointer px-4 py-3 text-xs font-medium">
        <span data-ph-public style={{ display: "contents" }}>
          Assets{" "}
        </span>
        <span className="text-secondary-ink">{assets.length}</span>
      </summary>
      <div className="max-h-56 overflow-y-auto overscroll-contain px-3 pb-3">
        {error && (
          <p role="status" className="mb-2 text-xs">
            {error}
          </p>
        )}
        <div className="grid grid-cols-3 gap-2">
          {assets.map((asset) => {
            const name =
              names.get(asset.assetId) ?? `${asset.mimeType.slice(6)} ${asset.assetId.slice(0, 8)}`;
            return (
              <button
                key={asset.assetId}
                type="button"
                aria-label={`Place ${name}`}
                disabled={disabled}
                onClick={() => onPlace(asset)}
                className="rounded border border-primary-grey/60 bg-surface p-1 hover:bg-primary-grey/15 disabled:opacity-40"
              >
                <AssetThumbnail asset={asset} pool={images} />
                <span className="mt-1 block truncate text-[10px]">{name}</span>
              </button>
            );
          })}
        </div>
        {more && (
          <button
            data-ph-public
            type="button"
            disabled={loading}
            onClick={onMore}
            className="mt-2 text-xs underline"
          >
            {loading ? "Loading assets…" : "More assets"}
          </button>
        )}
      </div>
    </details>
  );
}
