import type { RasterPixels, RasterTrace } from "./contract";

export type TraceQuality = {
  meanError: number;
  alphaError: number;
  changedFraction: number;
  worstTileError: number;
};
/** Compare both light and dark composites so transparent mistakes cannot hide
 * behind the canvas background. Local tiles expose detail loss on mostly blank art. */
export function measureRasterTrace(
  original: RasterPixels,
  rendered: Uint8ClampedArray,
): TraceQuality {
  if (rendered.length !== original.data.length)
    throw new Error("Trace verification dimensions differ.");
  const { data, width, height } = original;
  const tilesWide = Math.ceil(width / 16),
    tiles = new Float64Array(tilesWide * Math.ceil(height / 16));
  const counts = new Uint16Array(tiles.length);
  let total = 0,
    alpha = 0,
    changed = 0;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const i = pixel * 4,
      a = data[i + 3] / 255,
      b = rendered[i + 3] / 255;
    let error = 0;
    for (let k = 0; k < 3; k++) {
      const delta = data[i + k] * a - rendered[i + k] * b;
      error += Math.max(Math.abs(delta + 255 * (b - a)), Math.abs(delta));
    }
    error /= 3;
    total += error;
    alpha += Math.abs(data[i + 3] - rendered[i + 3]);
    if (error > 25) changed++;
    const tile = Math.floor((pixel % width) / 16) + Math.floor(pixel / width / 16) * tilesWide;
    tiles[tile] += error;
    counts[tile]++;
  }
  return {
    meanError: total / (width * height),
    alphaError: alpha / (width * height),
    changedFraction: changed / (width * height),
    worstTileError: Math.max(...tiles.map((sum, i) => sum / counts[i])),
  };
}

export function traceCandidateIsFaithful(candidate: TraceQuality, baseline: TraceQuality): boolean {
  return (
    candidate.meanError <= baseline.meanError + 0.5 &&
    candidate.alphaError <= baseline.alphaError + 0.5 &&
    candidate.changedFraction <= baseline.changedFraction + 0.005 &&
    candidate.worstTileError <= baseline.worstTileError + 8
  );
}

/** Reject an optimisation rather than publishing a cleaner but less faithful image.
 * These are measured errors, not an invented percentage confidence score. */
export function verifyRasterTrace(
  original: RasterPixels,
  proposed: RasterTrace,
  context?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null,
): RasterTrace {
  if (!context) {
    const canvas = document.createElement("canvas");
    canvas.width = original.width;
    canvas.height = original.height;
    context = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!context) throw new Error("Canvas trace verification is unavailable.");
  const drawing = context;
  const canvas = drawing.canvas;
  const render = (trace: RasterTrace) => {
    drawing.clearRect(0, 0, canvas.width, canvas.height);
    for (const path of trace.paths) {
      drawing.save();
      drawing.globalAlpha = path.opacity;
      let geometry = new Path2D(path.vectorPath.d);
      if (path.fill) {
        const paint = path.fill;
        const fill =
          paint.type === "linear"
            ? drawing.createLinearGradient(
                paint.start!.x * trace.width,
                paint.start!.y * trace.height,
                paint.end!.x * trace.width,
                paint.end!.y * trace.height,
              )
            : (() => {
                const cx = paint.centerX * trace.width,
                  cy = paint.centerY * trace.height;
                const rx = paint.radiusX * trace.width,
                  ry = paint.radiusY * trace.height;
                drawing.translate(cx, cy);
                drawing.scale(rx, ry);
                const transformed = new Path2D();
                transformed.addPath(
                  geometry,
                  new DOMMatrix([1 / rx, 0, 0, 1 / ry, -cx / rx, -cy / ry]),
                );
                geometry = transformed;
                const gradient = drawing.createRadialGradient(0, 0, 0, 0, 0, 1);
                return gradient;
              })();
        for (const stop of paint.stops) fill.addColorStop(stop.position, stop.color);
        drawing.fillStyle = fill;
      } else drawing.fillStyle = path.color;
      drawing.fill(geometry, path.vectorPath.fillRule);
      drawing.restore();
    }
    return measureRasterTrace(
      original,
      drawing.getImageData(0, 0, canvas.width, canvas.height).data,
    );
  };
  const { fallback, ...trace } = proposed;
  const quality = render(trace);
  const baseline = fallback && render(fallback);
  return selectVerifiedRasterTrace(proposed, quality, baseline);
}

export function selectVerifiedRasterTrace(
  proposed: RasterTrace,
  quality: TraceQuality,
  baseline?: TraceQuality,
): RasterTrace {
  const { fallback, ...trace } = proposed;
  const accepted =
    fallback && baseline && !traceCandidateIsFaithful(quality, baseline) ? fallback : trace;
  const acceptedQuality = accepted === fallback ? baseline! : quality;
  // Never silently turn a detailed image into mostly missing or wildly different artwork.
  if (
    acceptedQuality.meanError > 20 ||
    acceptedQuality.changedFraction > 0.3 ||
    acceptedQuality.worstTileError > 80
  )
    throw new Error(
      "This image loses too much detail when vectorised. Try more colours or a cleaner source image.",
    );
  return accepted;
}
