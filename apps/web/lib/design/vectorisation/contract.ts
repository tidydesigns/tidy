import type { DesignNode, DesignPaint } from "../document";

export const traceLimits = {
  pixels: 262144,
  edge: 1024,
  paths: 256,
  points: 12000,
  bytes: 1500000,
  timeout: 20000,
} as const;
export type TraceColors = "auto" | 2 | 8 | 16 | 32;
export type RasterPixels = { width: number; height: number; data: Uint8ClampedArray };
export type TraceStage = "reading" | "tracing" | "checking";
export type RasterTrace = {
  fallback?: Omit<RasterTrace, "fallback">;
  width: number;
  height: number;
  paths: {
    name?: string;
    fill?: Extract<DesignPaint, { type: "linear" | "radial" }>;
    vectorPath: NonNullable<DesignNode["vectorPath"]>;
    color: string;
    opacity: number;
  }[];
  pointCount: number;
};
export function traceSize(width: number, height: number) {
  if (![width, height].every((n) => Number.isFinite(n) && n >= 1 && n <= 5000))
    throw new Error("Image bounds must be between 1 and 5,000 pixels.");
  const factor = Math.min(
    1,
    traceLimits.edge / Math.max(width, height),
    Math.sqrt(traceLimits.pixels / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * factor)),
    height: Math.max(1, Math.floor(height * factor)),
  };
}
