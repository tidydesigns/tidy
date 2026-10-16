import type { RasterPixels, RasterTrace } from "./contract";

export type TraceQuality = {
  meanError: number;
  alphaError: number;
  changedFraction: number;
  worstTileError: number;
  detailLoss: number;
};
type VerificationOptions = { automatic?: boolean; lossy?: boolean };

function narrowFeatures(data: Uint8ClampedArray, width: number, height: number) {
  const features = new Float32Array(width * height);
  const steps = [4, width * 4];
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x,
        i = p * 4;
      for (let k = 0; k < 4; k++) {
        const value = k === 3 ? data[i + 3] : (data[i + k] * data[i + 3]) / 255;
        for (const step of steps) {
          const left =
            k === 3 ? data[i - step + 3] : (data[i - step + k] * data[i - step + 3]) / 255;
          const right =
            k === 3 ? data[i + step + 3] : (data[i + step + k] * data[i + step + 3]) / 255;
          const a = value - left,
            b = value - right;
          if (a * b > 0) features[p] = Math.max(features[p], Math.min(Math.abs(a), Math.abs(b)));
        }
      }
    }
  return features;
}
/** Compare both light and dark composites so transparent mistakes cannot hide
 * behind the canvas background. Local tiles expose detail loss on mostly blank art. */
export function measureRasterTrace(
  original: RasterPixels,
  rendered: Uint8ClampedArray,
  features?: Float32Array,
): TraceQuality {
  if (rendered.length !== original.data.length)
    throw new Error("Trace verification dimensions differ.");
  const { data, width, height } = original;
  const sourceFeatures = features ?? narrowFeatures(data, width, height),
    tracedFeatures = narrowFeatures(rendered, width, height);
  let signal = 0,
    lost = 0;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x,
        strength = sourceFeatures[p];
      if (strength < 16) continue;
      let retained = 0;
      // Coverage may move one pixel when a contour is fitted at subpixel precision.
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          retained = Math.max(retained, tracedFeatures[p + dy * width + dx]);
      signal += strength;
      lost += Math.max(0, strength - retained * 2);
    }
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
    detailLoss: signal > width * height * 0.03 ? lost / signal : 0,
  };
}

export function traceCandidateIsFaithful(
  candidate: TraceQuality,
  baseline: TraceQuality,
  checkDetails = true,
): boolean {
  return (
    candidate.meanError <= baseline.meanError + 0.5 &&
    candidate.alphaError <= baseline.alphaError + 0.5 &&
    candidate.changedFraction <= baseline.changedFraction + 0.005 &&
    (!checkDetails || candidate.detailLoss <= baseline.detailLoss + 0.03) &&
    candidate.worstTileError <= baseline.worstTileError + 8
  );
}

/** Reject an optimisation rather than publishing a cleaner but less faithful image.
 * These are measured errors, not an invented percentage confidence score. */
export function verifyRasterTrace(
  original: RasterPixels,
  proposed: RasterTrace,
  context?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null,
  options: VerificationOptions = {},
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
  const features = narrowFeatures(original.data, original.width, original.height);
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
                drawing.rotate(((paint.rotation ?? 0) * Math.PI) / 180);
                drawing.scale(rx, ry);
                const transformed = new Path2D();
                transformed.addPath(
                  geometry,
                  new DOMMatrix()
                    .translate(cx, cy)
                    .rotate(paint.rotation ?? 0)
                    .scale(rx, ry)
                    .inverse(),
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
      features,
    );
  };
  const { fallback, ...trace } = proposed;
  const quality = render(trace);
  // A candidate within every tolerance of a perfect baseline cannot lose the
  // comparison. Avoid a second rasterisation/scan when the result is already exact.
  const exact: TraceQuality = {
    meanError: 0,
    alphaError: 0,
    changedFraction: 0,
    worstTileError: 0,
    detailLoss: 0,
  };
  const baseline =
    fallback && !traceCandidateIsFaithful(quality, exact, !options.lossy)
      ? render(fallback)
      : undefined;
  return selectVerifiedRasterTrace(proposed, quality, baseline, options);
}

export function selectVerifiedRasterTrace(
  proposed: RasterTrace,
  quality: TraceQuality,
  baseline?: TraceQuality,
  options: VerificationOptions = {},
): RasterTrace {
  const { fallback, ...trace } = proposed;
  const accepted =
    fallback && baseline && !traceCandidateIsFaithful(quality, baseline, !options.lossy)
      ? fallback
      : trace;
  const acceptedQuality = accepted === fallback ? baseline! : quality;
  // Never silently turn a detailed image into mostly missing or wildly different artwork.
  if (
    acceptedQuality.meanError > (options.automatic ? 3 : 20) ||
    (options.automatic && !options.lossy && acceptedQuality.detailLoss > 0.2) ||
    acceptedQuality.changedFraction > 0.3 ||
    acceptedQuality.worstTileError > 80
  )
    throw new Error(
      "This image loses too much detail when vectorised. Try more colours or a cleaner source image.",
    );
  return accepted;
}
