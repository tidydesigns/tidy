import { mapConcurrent } from "../map-concurrent";
function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
/** Rasterization needs self-contained URLs; each original is fetched once. */
export async function embedDesignImages(clone: HTMLElement, signal?: AbortSignal) {
  clone.querySelectorAll("[data-image-fallback]").forEach((element) => element.remove());
  const images = [...clone.querySelectorAll("img, svg image")];
  const sources = images.map(
    (image) =>
      image.getAttribute("data-original-src") ??
      (image instanceof HTMLImageElement ? image.src : (image.getAttribute("href") ?? "")),
  );
  const data = new Map(
    await mapConcurrent([...new Set(sources)], 4, async (url) => {
      if (url.startsWith("data:")) return [url, url] as const;
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error("Could not include an image in the export.");
      return [url, await asDataUrl(await response.blob())] as const;
    }),
  );
  images.forEach((image, index) => {
    if (image instanceof HTMLImageElement) image.src = data.get(sources[index])!;
    else image.setAttribute("href", data.get(sources[index])!);
  });
}
