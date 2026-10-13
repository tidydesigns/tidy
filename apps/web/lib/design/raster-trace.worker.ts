import { traceRaster } from "./raster-trace";
import type { TraceColors } from "./raster-trace-contract";

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
    worker.postMessage({
      trace: traceRaster(
        { width: data.width, height: data.height, data: new Uint8ClampedArray(data.buffer) },
        data.colors,
        { lossy: data.lossy },
      ),
    });
  } catch (error) {
    worker.postMessage({
      error: error instanceof Error ? error.message : "Could not trace this image.",
    });
  }
};
