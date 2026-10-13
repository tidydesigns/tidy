import type { DesignNode } from "@bella/design/document";
const widths = [128, 256, 512, 1024, 2048];
export function isManagedImage(source: string) {
  return /^\/api\/(assets\/[^/?]+|github\/reviews\/[^/?]+\/(assets|captures)\/[^/?]+)(\?|$)/.test(
    source,
  );
}
/** Unknown formats use the original until authoritative MIME metadata is available. */
export function displayImageUrl(source: string, pixels: number, mimeType?: string) {
  if (!isManagedImage(source)) return source;
  const url = new URL(source, "https://design.invalid");
  url.searchParams.delete("width");
  if (mimeType && mimeType !== "image/svg+xml") {
    const width = widths.find((width) => width >= pixels);
    if (width) url.searchParams.set("width", String(width));
  }
  return url.pathname + url.search;
}

/** Width of the entire source needed to cover the painted pixels, not just
 * the crop's frame. Both axes matter for cover, fill and extreme aspect ratios. */
export function imageDisplayPixels(
  node: DesignNode,
  width: number,
  height: number,
  density: number,
  aspect?: number,
) {
  const crop = node.style.imageCrop;
  const ratio = crop ? crop.sourceWidth / crop.sourceHeight : aspect;
  const fit = node.style.objectFit ?? (crop ? "cover" : "contain");
  if (!ratio || !(ratio > 0)) return fit === "cover" ? 128 : width * density;
  const horizontal = width / (crop?.width ?? 1);
  const vertical = (height * ratio) / (crop?.height ?? 1);
  return (
    (fit === "contain" ? Math.min(horizontal, vertical) : Math.max(horizontal, vertical)) * density
  );
}
