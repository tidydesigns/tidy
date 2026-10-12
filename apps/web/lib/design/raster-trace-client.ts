import { imageAdjustmentFilter, hasImageAdjustments } from "@bella/design/image-adjustments";
import type { DesignNode } from "./document";
import { imageViewport } from "./image-viewport";
import {
  traceLimits,
  traceSize,
  type RasterTrace,
  type TraceColors,
} from "./raster-trace-contract";

const aborted = () => new DOMException("Vectorisation cancelled.", "AbortError");
function check(signal: AbortSignal) {
  if (signal.aborted) throw aborted();
}
function decode(source: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", cancel);
      image.onload = image.onerror = null;
      if (error) {
        image.src = "";
        reject(error);
      } else resolve(image);
    };
    const cancel = () => finish(aborted());
    image.onload = () => finish();
    image.onerror = () => finish(new Error("Could not decode this image."));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    else image.src = source;
  });
}

/** Rasterise the visible image content; outer borders, opacity, rotation and effects stay on the group. */
export async function traceImage(
  node: DesignNode,
  source: string,
  colors: TraceColors,
  signal: AbortSignal,
): Promise<RasterTrace> {
  check(signal);
  const response = await fetch(source, { signal, credentials: "same-origin" });
  if (!response.ok) throw new Error("Could not read the image. Check your file access.");
  const mime = response.headers.get("content-type")?.split(";")[0];
  if (!mime || !["image/png", "image/jpeg", "image/webp"].includes(mime))
    throw new Error("Vectorisation supports PNG, JPEG and WebP images.");
  // Bound streamed bytes even when Content-Length is absent or incorrect.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The image response is empty.");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      check(signal);
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2000000) throw new Error("Choose an image under 2 MB.");
      chunks.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel();
  }
  const blob = new Blob(chunks, { type: mime });
  const sourceUrl = URL.createObjectURL(blob);
  let rasterUrl: string | undefined;
  try {
    const image = await decode(sourceUrl, signal);
    if (image.naturalWidth * image.naturalHeight > 16000000)
      throw new Error("Choose an image with at most 16 million source pixels.");
    const viewport = imageViewport(node);
    const size = traceSize(viewport.width, viewport.height);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      const cancel = () => reader.abort();
      signal.addEventListener("abort", cancel, { once: true });
      reader.onloadend = () => {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) reject(aborted());
        else if (reader.error || typeof reader.result !== "string")
          reject(new Error("Could not read image pixels."));
        else resolve(reader.result);
      };
      if (signal.aborted) {
        signal.removeEventListener("abort", cancel);
        reject(aborted());
      } else reader.readAsDataURL(blob);
    });
    const crop = node.style.imageCrop;
    const preserve =
      node.style.objectFit === "fill"
        ? "none"
        : node.style.objectFit === "cover" || (crop && !node.style.objectFit)
          ? "xMidYMid slice"
          : "xMidYMid meet";
    let imageMarkup: string;
    if (crop) {
      imageMarkup = `<svg width="${viewport.width}" height="${viewport.height}" viewBox="${crop.x * crop.sourceWidth} ${crop.y * crop.sourceHeight} ${crop.width * crop.sourceWidth} ${crop.height * crop.sourceHeight}" preserveAspectRatio="${preserve}" overflow="hidden"><image width="${crop.sourceWidth}" height="${crop.sourceHeight}" href="${dataUrl}" filter="url(#trace-adjust)"/></svg>`;
    } else {
      const fit = node.style.objectFit ?? "contain";
      const factor =
        fit === "cover"
          ? Math.max(viewport.width / image.naturalWidth, viewport.height / image.naturalHeight)
          : Math.min(viewport.width / image.naturalWidth, viewport.height / image.naturalHeight);
      const scale = node.style.objectScale ?? 1;
      const width = (fit === "fill" ? viewport.width : image.naturalWidth * factor) * scale;
      const height = (fit === "fill" ? viewport.height : image.naturalHeight * factor) * scale;
      const x = ((viewport.width - width) * (node.style.objectPositionX ?? 50)) / 100;
      const y = ((viewport.height - height) * (node.style.objectPositionY ?? 50)) / 100;
      imageMarkup = `<image x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="none" href="${dataUrl}" filter="url(#trace-adjust)"/>`;
    }
    const filter = hasImageAdjustments(node.style.imageAdjustments)
      ? imageAdjustmentFilter("trace-adjust", node.style.imageAdjustments)
      : '<filter id="trace-adjust"><feComponentTransfer/></filter>';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${viewport.width} ${viewport.height}"><defs>${filter}</defs>${imageMarkup}</svg>`;
    rasterUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const raster = await decode(rasterUrl, signal);
    check(signal);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas image processing is unavailable.");
    context.drawImage(raster, 0, 0);
    const pixels = context.getImageData(0, 0, size.width, size.height);
    return await new Promise<RasterTrace>((resolve, reject) => {
      const worker = new Worker(new URL("./raster-trace.worker.ts", import.meta.url), {
        type: "module",
      });
      const finish = (error?: Error, trace?: RasterTrace) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", cancel);
        worker.terminate();
        if (error) reject(error);
        else resolve(trace!);
      };
      const cancel = () => finish(aborted());
      const timeout = setTimeout(
        () => finish(new Error("Vectorisation took too long. Try a simpler image.")),
        traceLimits.timeout,
      );
      signal.addEventListener("abort", cancel, { once: true });
      worker.onmessage = ({ data }: MessageEvent<{ trace?: RasterTrace; error?: string }>) => {
        if (data.error || !data.trace) finish(new Error(data.error ?? "No trace returned."));
        else finish(undefined, data.trace);
      };
      worker.onerror = () => finish(new Error("The image tracing worker failed."));
      worker.onmessageerror = () => finish(new Error("Could not read the trace result."));
      if (signal.aborted) cancel();
      else
        worker.postMessage(
          { width: size.width, height: size.height, buffer: pixels.data.buffer, colors },
          [pixels.data.buffer],
        );
    });
  } finally {
    URL.revokeObjectURL(sourceUrl);
    if (rasterUrl) URL.revokeObjectURL(rasterUrl);
  }
}
