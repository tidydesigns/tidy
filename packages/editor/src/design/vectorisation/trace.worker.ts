import { verifyRasterTrace } from "./quality";
import { traceRaster } from "./trace";
import { rasterTraceRequestSchema, type RasterTraceResponse } from "./contract";

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  try {
    const parsed = rasterTraceRequestSchema.safeParse(event.data);
    if (!parsed.success) throw new Error("Invalid vectorisation request.");
    const data = parsed.data;
    const image = {
      width: data.width,
      height: data.height,
      data: new Uint8ClampedArray(data.buffer),
    };
    // Keep rendering and pixel comparisons cancellable alongside the CPU trace.
    const context =
      typeof OffscreenCanvas !== "undefined" && typeof Path2D !== "undefined"
        ? new OffscreenCanvas(data.width, data.height).getContext("2d", {
            willReadFrequently: true,
          })
        : null;
    const original = context ? { ...image, data: image.data.slice() } : undefined;
    const trace = traceRaster(image, data.colors, { lossy: data.lossy });
    self.postMessage({
      kind: "success",
      trace: original
        ? verifyRasterTrace(original, trace, context, {
            automatic: data.colors === "auto",
            lossy: data.lossy,
          })
        : trace,
      verified: !!original,
    } satisfies RasterTraceResponse);
  } catch (error) {
    self.postMessage({
      kind: "error",
      error: error instanceof Error ? error.message : "Could not trace this image.",
    } satisfies RasterTraceResponse);
  }
});
