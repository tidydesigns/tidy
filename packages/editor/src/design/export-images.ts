import { mapConcurrent } from "../lib/map-concurrent";
import { isManagedImage } from "@tidy/design-renderer/image-display";
import { fetchImage } from "@tidy/design-renderer/image-loading";
function asDataUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const reader = new FileReader();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reader.abort();
      reject(signal?.reason);
    };
    reader.onload = () => {
      cleanup();
      if (signal?.aborted) reject(signal.reason);
      else resolve(String(reader.result));
    };
    reader.onerror = (error) => {
      cleanup();
      reject(error);
    };
    signal?.addEventListener("abort", abort, { once: true });
    reader.readAsDataURL(blob);
  });
}

async function originalDataUrl(url: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (url.startsWith("data:")) return url;
  if (isManagedImage(url))
    return asDataUrl(await fetchImage(url, signal ?? new AbortController().signal), signal);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Could not include an image in the export.");
  return asDataUrl(await response.blob(), signal);
}

export type ExportImageSession = {
  signal: AbortSignal;
  load(url: string): Promise<string>;
  dispose(): void;
};
const retainedStringBytes = 8 * 1024 * 1024;
const retainedEntries = 64;

/** Share full-quality originals only within one export. Never reuse a canvas
 * variant or retain private bytes across exports, users or workspaces. */
export function createExportImageSession(parent?: AbortSignal): ExportImageSession {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const entries = new Map<string, { promise: Promise<string>; bytes: number }>();
  let bytes = 0;
  const clear = () => {
    entries.clear();
    bytes = 0;
  };
  signal.addEventListener("abort", clear, { once: true });
  const evict = () => {
    const key = entries.keys().next().value;
    if (key === undefined) return;
    bytes -= entries.get(key)!.bytes;
    entries.delete(key);
  };
  return {
    signal,
    async load(url) {
      signal.throwIfAborted();
      // Only managed immutable originals are eligible; external URLs may change.
      if (!isManagedImage(url)) return originalDataUrl(url, signal);
      const hit = entries.get(url);
      if (hit) {
        entries.delete(url);
        entries.set(url, hit);
        return hit.promise;
      }
      while (entries.size >= retainedEntries) evict();
      const entry = { promise: originalDataUrl(url, signal), bytes: 0 };
      entries.set(url, entry);
      entry.promise = entry.promise.then(
        (value) => {
          signal.throwIfAborted();
          if (entries.get(url) !== entry) return value;
          // Estimate two bytes per UTF-16 code unit.
          // Export oversized entries without retaining them in the cache.
          entry.bytes = 2 * (url.length + value.length);
          bytes += entry.bytes;
          while (bytes > retainedStringBytes) evict();
          return value;
        },
        (error) => {
          if (entries.get(url) === entry) entries.delete(url);
          throw error;
        },
      );
      return entry.promise;
    },
    dispose() {
      controller.abort();
      clear();
      signal.removeEventListener("abort", clear);
    },
  };
}
/** Rasterization needs self-contained URLs; each original is fetched once. */
export async function embedDesignImages(
  clone: HTMLElement,
  parent?: AbortSignal,
  session?: ExportImageSession,
) {
  const signal =
    parent && session ? AbortSignal.any([parent, session.signal]) : (parent ?? session?.signal);
  signal?.throwIfAborted();
  clone.querySelectorAll("[data-image-fallback]").forEach((element) => element.remove());
  const images = [...clone.querySelectorAll("img, svg image")];
  const sources = images.map(
    (image) =>
      image.getAttribute("data-original-src") ??
      (image instanceof HTMLImageElement ? image.src : (image.getAttribute("href") ?? "")),
  );
  const masks = [...clone.querySelectorAll<HTMLElement>("[style]")].flatMap((element) => {
    const css = element.style.maskImage || element.style.webkitMaskImage;
    const match = css?.match(/url\("([^"]+)"\)/);
    if (!match || match[1].startsWith("data:")) return [];
    return [{ element, css, url: match[1] }];
  });
  const data = new Map(
    await mapConcurrent(
      [...new Set([...sources, ...masks.map((mask) => mask.url)])],
      4,
      async (url) => {
        return [url, await (session ? session.load(url) : originalDataUrl(url, signal))] as const;
      },
    ),
  );
  signal?.throwIfAborted();
  images.forEach((image, index) => {
    if (image instanceof HTMLImageElement) image.src = data.get(sources[index])!;
    else image.setAttribute("href", data.get(sources[index])!);
  });
  for (const mask of masks) {
    const css = mask.css.replace(
      `url(${JSON.stringify(mask.url)})`,
      `url(${JSON.stringify(data.get(mask.url)!)})`,
    );
    mask.element.style.maskImage = css;
    mask.element.style.webkitMaskImage = css;
  }
}
