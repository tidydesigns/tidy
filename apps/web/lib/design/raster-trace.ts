import tracer, { type TraceColor, type TracePath } from "imagetracerjs";
import {
  serializeContours,
  type VectorAnchor,
  type VectorContour,
} from "@bella/design/vector-geometry";
import { recoverRasterOcclusion } from "./raster-occlusion";
import { refineRasterCoverage } from "./raster-coverage";
import { fitRasterShape } from "./raster-shape-fit";
import { designNodeSchema } from "./document";
import { traceLimits, type TraceColors, type RasterTrace } from "./raster-trace-contract";

/** Deterministic, frequency-weighted diverse seeds; no random sampling, hidden RGB or white removal. */
function palette(data: Uint8ClampedArray, colors: TraceColors, imageWidth: number): TraceColor[] {
  let visiblePixels = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]) visiblePixels++;
  const histogram = new Map<
    number,
    { color: TraceColor; count: number; peak: number; core: number; samples: Map<number, number> }
  >();
  let transparent = false;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) {
      data[i] = data[i + 1] = data[i + 2] = 0;
      transparent = true;
      continue;
    }
    const key =
      ((data[i] >> 5) << 10) |
      ((data[i + 1] >> 5) << 7) |
      ((data[i + 2] >> 5) << 4) |
      (data[i + 3] >> 4);
    const pixel = i / 4,
      x = pixel % imageWidth;
    const core =
      x > 0 &&
      x < imageWidth - 1 &&
      pixel >= imageWidth &&
      pixel < data.length / 4 - imageWidth &&
      [-1, 1, -imageWidth, imageWidth].every((offset) =>
        [0, 1, 2, 3].every((k) => Math.abs(data[i + k] - data[i + offset * 4 + k]) <= 4),
      );
    const entry = histogram.get(key);
    const sample = ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
    if (entry) {
      entry.count++;
      if (core) entry.core++;
      const frequency = (entry.samples.get(sample) ?? 0) + 1;
      entry.samples.set(sample, frequency);
      if (frequency > entry.peak) {
        entry.peak = frequency;
        entry.color = { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
      }
    } else
      histogram.set(key, {
        color: { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] },
        count: 1,
        peak: 1,
        core: Number(core),
        samples: new Map([[sample, 1]]),
      });
  }
  const sorted = [...histogram.values()].sort((a, b) => b.count - a.count);
  // Do not spend the requested palette on isolated compression noise or edge colours.
  const remaining = sorted.filter(
    (entry, index) =>
      index === 0 || entry.core >= 4 || entry.count >= Math.max(4, visiblePixels * 0.003),
  );
  const chosen: TraceColor[] = transparent ? [{ r: 0, g: 0, b: 0, a: 0 }] : [];
  const distance = (a: TraceColor, b: TraceColor) =>
    Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) + Math.abs(a.a - b.a);
  if (remaining.length) chosen.push(remaining.shift()!.color);
  const isEdgeBlend = (entry: (typeof sorted)[number]) => {
    // A small bin containing many different samples is usually coverage or JPEG
    // ringing. Do not allocate a third paint to a blend of two established paints.
    // Repeated flat colours and substantial shaded areas remain eligible.
    if (entry.core >= 4 || entry.count >= visiblePixels * 0.01) return false;
    const values = (c: TraceColor) => [c.r, c.g, c.b, c.a];
    const p = values(entry.color);
    for (let i = 0; i < chosen.length; i++)
      for (let j = i + 1; j < chosen.length; j++) {
        if (!chosen[i].a || !chosen[j].a) continue;
        const a = values(chosen[i]),
          b = values(chosen[j]),
          d = b.map((value, k) => value - a[k]);
        const length = d.reduce((sum, value) => sum + value * value, 0);
        if (!length) continue;
        const t = p.reduce((sum, value, k) => sum + (value - a[k]) * d[k], 0) / length;
        if (t <= 0 || t >= 1) continue;
        if (p.reduce((sum, value, k) => sum + (value - a[k] - t * d[k]) ** 2, 0) < 24 ** 2)
          return true;
      }
    return false;
  };
  while (remaining.length && chosen.length < colors + Number(transparent)) {
    for (let i = remaining.length - 1; i >= 0; i--)
      if (
        chosen.some((color) => color.a > 0 && distance(color, remaining[i].color) < 48) ||
        isEdgeBlend(remaining[i])
      )
        remaining.splice(i, 1);
    if (!remaining.length) break;
    let best = 0,
      score = -1;
    for (let i = 0; i < remaining.length; i++) {
      const entry = remaining[i];
      const value =
        Math.min(...chosen.map((color) => distance(color, entry.color))) * Math.sqrt(entry.count);
      if (value > score) {
        best = i;
        score = value;
      }
    }
    chosen.push(remaining.splice(best, 1)[0].color);
  }
  return chosen;
}

/** Coverage has the same RGB as a nearby interior but a lower alpha. Resolve it
 * locally: a long half-covered stroke edge is not a separate translucent object.
 * Distinct translucent fills retain their interior alpha, including overlap colours.
 */
function resolveCoverage(image: { width: number; height: number; data: Uint8ClampedArray }) {
  const { width, height, data } = image;
  const original = data.slice();
  for (let pixel = 0; pixel < width * height; pixel++) {
    const i = pixel * 4,
      alpha = original[i + 3];
    if (!alpha || alpha === 255) continue;
    const x = pixel % width,
      y = Math.floor(pixel / width);
    let interior = alpha;
    for (let yy = Math.max(0, y - 2); yy <= Math.min(height - 1, y + 2); yy++)
      for (let xx = Math.max(0, x - 2); xx <= Math.min(width - 1, x + 2); xx++) {
        const j = (yy * width + xx) * 4;
        if (
          original[j + 3] > interior &&
          [0, 1, 2].every((k) => Math.abs(original[i + k] - original[j + k]) <= 8)
        )
          interior = original[j + 3];
      }
    if (interior > alpha) data[i + 3] = alpha < interior / 2 ? 0 : interior;
  }
}

/** Resolve coverage blends against adjacent solid regions, rather than unrelated palette colours.
 * A pixel between a green shape and a cream shape must not invent a yellow object.
 * Quantisation is fixed after this step so the tracer cannot move the palette or relabel edges.
 */
function separateRegions(
  image: { width: number; height: number; data: Uint8ClampedArray },
  palette: TraceColor[],
) {
  const { width, height, data } = image;
  const count = width * height;
  const labels = new Int16Array(count).fill(-1);
  const nearest = new Int16Array(count);
  const queue = new Int32Array(count);
  let tail = 0;
  const distance = (pixel: number, color: TraceColor) => {
    const i = pixel * 4,
      alpha = data[i + 3] / 255,
      other = color.a / 255;
    return (
      (data[i] * alpha - color.r * other) ** 2 +
      (data[i + 1] * alpha - color.g * other) ** 2 +
      (data[i + 2] * alpha - color.b * other) ** 2 +
      (data[i + 3] - color.a) ** 2
    );
  };
  const similar = (a: number, b: number) => {
    for (let k = 0; k < 4; k++) if (Math.abs(data[a * 4 + k] - data[b * 4 + k]) > 8) return false;
    return true;
  };
  for (let pixel = 0; pixel < count; pixel++) {
    let best = 0,
      error = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const value = distance(pixel, palette[i]);
      if (value < error) {
        best = i;
        error = value;
      }
    }
    nearest[pixel] = best;
    const x = pixel % width,
      y = Math.floor(pixel / width);
    // Exact colours preserve thin strokes and small accents; flat interiors also seed
    // photographs/gradients when their colours have been reduced to the requested palette.
    const flat =
      x > 0 &&
      x < width - 1 &&
      y > 0 &&
      y < height - 1 &&
      [pixel - 1, pixel + 1, pixel - width, pixel + width].every((p) => similar(pixel, p));
    if (error <= 144 || flat) {
      labels[pixel] = best;
      queue[tail++] = pixel;
    }
  }
  // Expand one distance wave at a time. Every ambiguous edge may only inherit a
  // label from the previous wave, so scan direction cannot bias the silhouette.
  let head = 0;
  while (head < tail) {
    const end = tail;
    const frontier: number[] = [];
    while (head < end) {
      const pixel = queue[head++],
        x = pixel % width;
      for (const next of [
        x > 0 ? pixel - 1 : -1,
        x < width - 1 ? pixel + 1 : -1,
        pixel >= width ? pixel - width : -1,
        pixel < count - width ? pixel + width : -1,
      ]) {
        if (next < 0 || labels[next] !== -1) continue;
        labels[next] = -2;
        frontier.push(next);
      }
    }
    const choices = frontier.map((pixel) => {
      const x = pixel % width;
      let best = nearest[pixel],
        error = Infinity;
      for (const next of [
        x > 0 ? pixel - 1 : -1,
        x < width - 1 ? pixel + 1 : -1,
        pixel >= width ? pixel - width : -1,
        pixel < count - width ? pixel + width : -1,
      ]) {
        if (next < 0 || labels[next] < 0) continue;
        const label = labels[next],
          value = distance(pixel, palette[label]);
        if (value < error) {
          best = label;
          error = value;
        }
      }
      return best;
    });
    frontier.forEach((pixel, i) => {
      labels[pixel] = choices[i];
      queue[tail++] = pixel;
    });
  }
  for (let pixel = 0; pixel < count; pixel++) {
    const color = palette[labels[pixel] < 0 ? nearest[pixel] : labels[pixel]];
    data.set([color.r, color.g, color.b, color.a], pixel * 4);
  }
}

function contour(path: TracePath, id: string): VectorContour {
  if (!path.segments.length || path.segments.length > 1000)
    throw new Error("This trace has too many points. Try fewer colours or a simpler image.");
  const first = path.segments[0];
  const points: VectorAnchor[] = [{ id: `${id}-0`, x: first.x1, y: first.y1 }];
  for (const segment of path.segments) {
    const previous = points.at(-1)!;
    const next: VectorAnchor = {
      id: `${id}-${points.length}`,
      x: segment.type === "Q" ? segment.x3 : segment.x2,
      y: segment.type === "Q" ? segment.y3 : segment.y2,
    };
    if (segment.type === "Q") {
      previous.out = {
        x: previous.x + (2 / 3) * (segment.x2 - previous.x),
        y: previous.y + (2 / 3) * (segment.y2 - previous.y),
      };
      next.in = {
        x: next.x + (2 / 3) * (segment.x2 - next.x),
        y: next.y + (2 / 3) * (segment.y2 - next.y),
      };
    }
    points.push(next);
  }
  const last = points.at(-1)!;
  if (last.x === points[0].x && last.y === points[0].y) {
    points[0].in = last.in;
    points.pop();
  }
  return { id, closed: true, points };
}

/** Worker-only CPU work. Return native contours, never untrusted SVG markup. */
export function traceRaster(
  image: { width: number; height: number; data: Uint8ClampedArray },
  colors: TraceColors,
): RasterTrace {
  if (![2, 8, 16].includes(colors)) throw new Error("Choose 2, 8 or 16 colours.");
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width > traceLimits.edge ||
    image.height > traceLimits.edge ||
    image.width * image.height > traceLimits.pixels ||
    image.data.length !== image.width * image.height * 4
  )
    throw new Error("Trace input exceeds the pixel limit.");
  const original = { ...image, data: image.data.slice() };
  resolveCoverage(image);
  const seeds = palette(image.data, colors, image.width);
  if (!seeds.some((color) => color.a > 0))
    throw new Error("This image has no visible pixels to trace.");
  separateRegions(image, seeds);
  const result = tracer.imagedataToTracedata(image, {
    pal: seeds,
    colorsampling: 0,
    colorquantcycles: 1,
    mincolorratio: 0,
    layering: 0,
    ltres: 1,
    qtres: 1,
    pathomit: 8,
    rightangleenhance: true,
    blurradius: 0,
    strokewidth: 0,
  });
  const paths: RasterTrace["paths"] = [];
  const underlays: { path: RasterTrace["paths"][number]; area: number }[] = [];
  let pointCount = 0;
  for (let layerIndex = 0; layerIndex < result.layers.length; layerIndex++) {
    const color = result.palette[layerIndex];
    if (!color.a) continue;
    const layer = result.layers[layerIndex];
    for (const path of layer) {
      if (path.isholepath) continue;
      if (paths.length >= traceLimits.paths || path.holechildren.length >= 100)
        throw new Error("This trace has too many shapes. Try fewer colours or a simpler image.");
      const fitted = [path, ...path.holechildren.map((index) => layer[index])].map((p, index) => {
        const raw = contour(p, `trace-${paths.length}-${index}`);
        const primitive = fitRasterShape(raw);
        return primitive.name
          ? primitive
          : fitRasterShape(refineRasterCoverage(raw, original, color.a));
      });
      // Recover an opaque primitive behind enclosed opaque artwork. A rounded
      // background with a leaf on it should remain a complete background when the
      // leaf moves. Transparent holes and translucent overlaps must stay untouched.
      const underlay =
        color.a === 255 &&
        !!fitted[0].name &&
        fitted.length > 1 &&
        fitted.slice(1).every(({ contour: hole }) => {
          const xs = hole.points.map((p) => p.x),
            ys = hole.points.map((p) => p.y);
          const left = Math.max(0, Math.floor(Math.min(...xs))),
            right = Math.min(image.width - 1, Math.ceil(Math.max(...xs)));
          const top = Math.max(0, Math.floor(Math.min(...ys))),
            bottom = Math.min(image.height - 1, Math.ceil(Math.max(...ys)));
          for (let y = top; y <= bottom; y++)
            for (let x = left; x <= right; x++)
              if (image.data[(y * image.width + x) * 4 + 3] !== 255) return false;
          return true;
        });
      const contours = (underlay ? fitted.slice(0, 1) : fitted).map((p) => p.contour);
      const outer = contours[0].points;
      // A closed line has no fill. Do not create an invisible layer for a collapsed
      // raster speck; two-anchor curves can still enclose genuine visible geometry.
      if (
        !outer.some((point) => point.in || point.out) &&
        Math.abs(
          outer.reduce((sum, point, i) => {
            const next = outer[(i + 1) % outer.length];
            return sum + point.x * next.y - next.x * point.y;
          }, 0),
        ) < 0.000001
      )
        continue;
      pointCount += contours.reduce((sum, c) => sum + c.points.length, 0);
      if (pointCount > traceLimits.points)
        throw new Error("This trace has too many points. Try fewer colours or a simpler image.");
      const vectorPath = {
        d: serializeContours(contours),
        contours,
        viewBox: { x: 0, y: 0, width: image.width, height: image.height },
        fillRule: "evenodd" as const,
      };
      // Reuse exactly the limits enforced by document persistence and the point editor.
      const checked = designNodeSchema.shape.vectorPath.safeParse(vectorPath);
      if (!checked.success)
        throw new Error(
          "This trace exceeds the editable path limits. Try fewer colours or a simpler image.",
        );
      const tracedPath = {
        name: fitted[0].name,
        vectorPath,
        color: `#${[color.r, color.g, color.b].map((value) => value.toString(16).padStart(2, "0")).join("")}`,
        opacity: color.a / 255,
      };
      paths.push(tracedPath);
      if (underlay) {
        const xs = contours[0].points.map((p) => p.x),
          ys = contours[0].points.map((p) => p.y);
        underlays.push({
          path: tracedPath,
          area: (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)),
        });
      }
    }
  }
  if (!paths.length) throw new Error("No shapes survived tracing. Try a larger image.");
  const underneath = new Set(underlays.map((entry) => entry.path));
  const ordered = [
    ...underlays.sort((a, b) => b.area - a.area).map((entry) => entry.path),
    ...paths.filter((path) => !underneath.has(path)),
  ];
  const recovered = recoverRasterOcclusion(ordered, image);
  pointCount = recovered.reduce(
    (sum, path) => sum + path.vectorPath.contours!.reduce((n, c) => n + c.points.length, 0),
    0,
  );
  const trace = { width: image.width, height: image.height, paths: recovered, pointCount };
  if (new TextEncoder().encode(JSON.stringify(trace)).length > traceLimits.bytes)
    throw new Error("This trace is too large for the canvas. Try fewer colours.");
  return trace;
}
