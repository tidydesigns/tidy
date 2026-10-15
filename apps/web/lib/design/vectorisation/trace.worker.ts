import { verifyRasterTrace } from "./quality";
import { traceRaster } from "./trace";
import type { TraceColors } from "./contract";

const worker = self as unknown as {
  onmessage:
    | ((
        event: MessageEvent<{
          width: number;
          height: number;
          buffer: ArrayBuffer;
          colors: TraceColors;
          lossy?: boolean;
        }>,
      ) => void)
    | null;
  postMessage: (message: unknown) => void;
};
worker.onmessage = ({ data }) => {
  try {
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
    worker.postMessage({
      trace: original ? verifyRasterTrace(original, trace, context) : trace,
      verified: !!original,
    });
  } catch (error) {
    worker.postMessage({
      error: error instanceof Error ? error.message : "Could not trace this image.",
    });
  }
};
