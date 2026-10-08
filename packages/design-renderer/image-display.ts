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
