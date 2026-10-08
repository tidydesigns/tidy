"use client";
import type { DesignNode } from "@bella/design/document";
import { imageStyle } from "./node-style";
import { vectorImageStyle, vectorSvg } from "./vector-path";
import { useId, useCallback, useSyncExternalStore, useState } from "react";
import { displayImageUrl, isManagedImage } from "./image-display";
import { useImageMimeType } from "./image-context";
import { subscribeImage, type ImageLoad } from "./image-loading";
const loading: ImageLoad = { status: "loading" };
function useLoadedImage(source: string) {
  const [store] = useState(() => ({ source: "", state: loading }));
  const subscribe = useCallback(
    (notify: () => void) => {
      store.source = source;
      store.state = loading;
      if (!isManagedImage(source)) return () => {};
      return subscribeImage(source, (state) => {
        store.state = state;
        notify();
      });
    },
    [source, store],
  );
  const snapshot = useCallback(
    () => (store.source === source ? store.state : loading),
    [source, store],
  );
  return useSyncExternalStore(subscribe, snapshot, () => loading);
}
const emptyImage = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E";
const fallback =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#eeeeee"/><path d="M22 22l20 20m0-20L22 42" stroke="#888888" stroke-width="2"/></svg>',
  );
/** The same non-destructive source crop renders on canvas, previews and exports. */
export function DesignImage({
  node,
  src = "",
  tokens = {},
  mimeType,
}: {
  node: DesignNode;
  src?: string;
  tokens?: Record<string, string>;
  mimeType?: string;
}) {
  const id = useId(),
    crop = node.style.imageCrop;
  const metadata = useImageMimeType(node.assetId);
  const display = displayImageUrl(
    src,
    (node.box.width * 6) / (crop?.width ?? 1),
    mimeType ?? metadata,
  );
  const load = useLoadedImage(node.vectorPath ? "" : display);
  const [decodeError, setDecodeError] = useState<string>();
  const resolved = isManagedImage(display)
    ? load.status === "ready"
      ? load.url
      : undefined
    : display;
  const failed = load.status === "failed" || (resolved !== undefined && decodeError === resolved);
  if (node.vectorPath)
    return (
      <img
        data-vector-path
        src={`data:image/svg+xml,${encodeURIComponent(vectorSvg(node, tokens))}`}
        alt={node.name}
        draggable={false}
        style={vectorImageStyle(node)}
      />
    );
  if (!crop)
    return (
      <img
        src={failed ? fallback : (resolved ?? emptyImage)}
        data-original-src={src}
        data-image-loading={(!failed && resolved === undefined) || undefined}
        data-image-failed={failed || undefined}
        onError={() => setDecodeError(resolved)}
        alt={failed ? `${node.name || "Image"} unavailable` : node.name}
        width={node.box.width}
        height={node.box.height}
        draggable={false}
        style={imageStyle(node)}
      />
    );
  const x = crop.x * crop.sourceWidth,
    y = crop.y * crop.sourceHeight,
    width = crop.width * crop.sourceWidth,
    height = crop.height * crop.sourceHeight;
  return (
    <svg
      role="img"
      aria-label={failed ? `${node.name || "Image"} unavailable` : node.name}
      data-image-failed={failed || undefined}
      data-image-crop
      viewBox={`${x} ${y} ${width} ${height}`}
      preserveAspectRatio={
        node.style.objectFit === "contain"
          ? "xMidYMid meet"
          : node.style.objectFit === "fill"
            ? "none"
            : "xMidYMid slice"
      }
      style={{ display: "block", width: "100%", height: "100%", overflow: "hidden" }}
    >
      <defs>
        <clipPath id={id}>
          <rect x={x} y={y} width={width} height={height} />
        </clipPath>
      </defs>
      {failed && (
        <g data-image-fallback>
          <rect x={x} y={y} width={width} height={height} fill="#eeeeee" />
          <path
            d={`M${x + width * 0.35} ${y + height * 0.35}L${x + width * 0.65} ${y + height * 0.65}M${x + width * 0.65} ${y + height * 0.35}L${x + width * 0.35} ${y + height * 0.65}`}
            stroke="#888888"
            strokeWidth={Math.min(width, height) / 32}
          />
        </g>
      )}
      <image
        href={resolved}
        data-original-src={src}
        onError={() => setDecodeError(resolved)}
        width={crop.sourceWidth}
        height={crop.sourceHeight}
        clipPath={`url(#${id})`}
      />
    </svg>
  );
}
