import { z } from "zod";
import { designNodeSchema } from "../document";

export const traceLimits = {
  pixels: 262144,
  edge: 1024,
  paths: 256,
  points: 12000,
  bytes: 1500000,
  timeout: 20000,
} as const;
const traceColorsSchema = z.union([
  z.literal("auto"),
  z.literal(2),
  z.literal(8),
  z.literal(16),
  z.literal(32),
]);
export type TraceColors = z.infer<typeof traceColorsSchema>;
export const rasterTraceRequestSchema = z
  .object({
    width: z.number().int().min(1).max(traceLimits.edge),
    height: z.number().int().min(1).max(traceLimits.edge),
    buffer: z.instanceof(ArrayBuffer),
    colors: traceColorsSchema,
    lossy: z.boolean().optional(),
  })
  .refine(
    ({ width, height, buffer }) =>
      width * height <= traceLimits.pixels && buffer.byteLength === width * height * 4,
    "Invalid raster pixel buffer.",
  );
export type RasterTraceRequest = z.infer<typeof rasterTraceRequestSchema>;
export type RasterPixels = { width: number; height: number; data: Uint8ClampedArray };
export type TraceStage = "reading" | "tracing" | "checking";
const paintOptions = designNodeSchema.shape.style.unwrap().shape.paints.unwrap().element.options;
const traceFillSchema = z.union([
  paintOptions[1].refine(
    (paint) => !!paint.start && !!paint.end,
    "Trace gradients need endpoints.",
  ),
  paintOptions[2],
]);
const traceGeometrySchema = z
  .object({
    width: z.number().int().min(1).max(traceLimits.edge),
    height: z.number().int().min(1).max(traceLimits.edge),
    paths: z
      .array(
        z
          .object({
            name: z.string().max(120).optional(),
            fill: traceFillSchema.optional(),
            vectorPath: designNodeSchema.shape.vectorPath.unwrap(),
            color: z.string().regex(/^#[0-9a-f]{6}$/i),
            opacity: z.number().min(0).max(1),
          })
          .strict(),
      )
      .min(1)
      .max(traceLimits.paths),
    pointCount: z.number().int().min(1).max(traceLimits.points),
  })
  .strict()
  .refine(
    (trace) => trace.width * trace.height <= traceLimits.pixels,
    "Trace exceeds pixel limits.",
  )
  .refine(
    (trace) =>
      trace.pointCount ===
      trace.paths.reduce(
        (sum, path) =>
          sum +
          (path.vectorPath.contours ?? []).reduce(
            (count, contour) => count + contour.points.length,
            0,
          ),
        0,
      ),
    "Trace point count must match its contours.",
  );
const rasterTraceSchema = traceGeometrySchema.safeExtend({
  fallback: traceGeometrySchema.optional(),
});
export type RasterTrace = z.infer<typeof rasterTraceSchema>;
export const rasterTraceResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("success"), trace: rasterTraceSchema, verified: z.boolean() })
    .strict(),
  z.object({ kind: z.literal("error"), error: z.string().min(1).max(1000) }).strict(),
]);
export type RasterTraceResponse = z.infer<typeof rasterTraceResponseSchema>;
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
