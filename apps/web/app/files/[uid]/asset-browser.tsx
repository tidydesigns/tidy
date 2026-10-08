"use client";
import type { DesignDocument } from "@/lib/design/document";
export type BrowserAsset = { assetId: string; mimeType: string; byteSize: number };

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
        Assets <span className="text-secondary-ink">{assets.length}</span>
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
                {/* Original bytes preserve SVGs and avoid displaying a cropped/derived variant. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/assets/${asset.assetId}`}
                  alt=""
                  className="h-12 w-full object-contain"
                  draggable={false}
                />
                <span className="mt-1 block truncate text-[10px]">{name}</span>
              </button>
            );
          })}
        </div>
        {more && (
          <button
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
