import type { TraceColor } from "imagetracerjs";
import type { TraceColors, RasterPixels } from "./contract";

function nearRgba(data: Uint8ClampedArray, a: number, b: number, rgb = 4, alpha = 4) {
  return (
    Math.abs(data[a] - data[b]) <= rgb &&
    Math.abs(data[a + 1] - data[b + 1]) <= rgb &&
    Math.abs(data[a + 2] - data[b + 2]) <= rgb &&
    Math.abs(data[a + 3] - data[b + 3]) <= alpha
  );
}

// A narrow extremum has no flat four-neighbour interior. Keep its coverage
// colour instead of treating it as an ordinary blend along a larger shape edge.
function thinFeature(data: Uint8ClampedArray, pixel: number, width: number) {
  const i = pixel * 4;
  if (data[i + 3] !== 255) return false;
  const x = pixel % width;
  for (let axis = 0; axis < 2; axis++) {
    const offset = axis === 0 ? 1 : width;
    if (offset === 1 && (x === 0 || x === width - 1)) continue;
    const before = i - offset * 4,
      after = i + offset * 4;
    if (before < 0 || after >= data.length) continue;
    for (let k = 0; k < 4; k++) {
      const value = data[i + k];
      const a = value - (k === 3 ? data[before + k] : (data[before + k] * data[before + 3]) / 255),
        b = value - (k === 3 ? data[after + k] : (data[after + k] * data[after + 3]) / 255);
      if ((a > 12 && b > 12) || (a < -12 && b < -12)) return true;
    }
  }
  return false;
}

function compactCore(data: Uint8ClampedArray, pixel: number, width: number) {
  const x = pixel % width,
    height = data.length / 4 / width,
    y = Math.floor(pixel / width);
  if (data[pixel * 4 + 3] !== 255) return false;
  for (const dx of [-1, 1]) {
    if (x + dx < 0 || x + dx >= width) continue;
    for (const dy of [-1, 1]) {
      if (y + dy < 0 || y + dy >= height) continue;
      if (
        nearRgba(data, pixel * 4, (pixel + dx) * 4) &&
        nearRgba(data, pixel * 4, (pixel + dy * width) * 4) &&
        nearRgba(data, pixel * 4, (pixel + dx + dy * width) * 4)
      )
        return true;
    }
  }
  return false;
}

/** Deterministic, frequency-weighted diverse seeds; no random sampling, hidden RGB or white removal. */
function palette(
  data: Uint8ClampedArray,
  colors: TraceColors,
  imageWidth: number,
  lossy: boolean,
): TraceColor[] {
  let visiblePixels = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]) visiblePixels++;
  const solidCores = new Map<number, { color: TraceColor; count: number }>();
  const histogram = new Map<
    number,
    {
      color: TraceColor;
      pixel: number;
      count: number;
      peak: number;
      core: number;
      detail: number;
      samples: Map<number, number>;
    }
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
      nearRgba(data, i, i - 4, lossy ? 32 : 4) &&
      nearRgba(data, i, i + 4, lossy ? 32 : 4) &&
      nearRgba(data, i, i - imageWidth * 4, lossy ? 32 : 4) &&
      nearRgba(data, i, i + imageWidth * 4, lossy ? 32 : 4);
    const entry = histogram.get(key);
    const sample = ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
    if (
      core &&
      nearRgba(data, i, i - 4, 0, 0) &&
      nearRgba(data, i, i + 4, 0, 0) &&
      nearRgba(data, i, i - imageWidth * 4, 0, 0) &&
      nearRgba(data, i, i + imageWidth * 4, 0, 0)
    ) {
      const solid = solidCores.get(sample);
      if (solid) solid.count++;
      else
        solidCores.set(sample, {
          color: { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] },
          count: 1,
        });
    }
    if (entry) {
      entry.count++;
      if (core) entry.core++;
      if (!lossy && colors === "auto" && thinFeature(data, pixel, imageWidth)) entry.detail++;
      const frequency = (entry.samples.get(sample) ?? 0) + 1;
      entry.samples.set(sample, frequency);
      if (frequency > entry.peak) {
        entry.peak = frequency;
        entry.color = { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
      }
    } else
      histogram.set(key, {
        pixel,
        color: { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] },
        count: 1,
        peak: 1,
        core: Number(core),
        detail: Number(!lossy && colors === "auto" && thinFeature(data, pixel, imageWidth)),
        samples: new Map([[sample, 1]]),
      });
  }
  if (!lossy)
    for (const entry of histogram.values())
      if (
        entry.core < 2 &&
        entry.count >= 4 &&
        entry.count <= 64 &&
        compactCore(data, entry.pixel, imageWidth)
      )
        entry.core = 4;
  const sorted = [
    ...[...histogram.values()].map((entry) => ({ ...entry, stable: false })),
    ...[...solidCores.values()]
      .filter((entry) => entry.count >= 4)
      .map((entry) => ({
        ...entry,
        peak: entry.count,
        core: entry.count,
        detail: 0,
        stable: true,
        samples: new Map<number, number>(),
      })),
  ].sort((a, b) => b.count - a.count);
  // Do not spend the requested palette on isolated compression noise or edge colours.
  const remaining = sorted.filter(
    (entry, index) =>
      index === 0 ||
      entry.core >= 4 ||
      entry.count >= 4 ||
      (!lossy && entry.color.a === 255 && entry.detail > 0),
  );
  const chosen: TraceColor[] = transparent ? [{ r: 0, g: 0, b: 0, a: 0 }] : [];
  const distance = (a: TraceColor, b: TraceColor) =>
    Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) + Math.abs(a.a - b.a);
  if (remaining.length) chosen.push(remaining.shift()!.color);
  let detailPaints = 0;
  const isEdgeBlend = (entry: (typeof sorted)[number]) => {
    // A small bin containing many different samples is usually coverage or JPEG
    // ringing. Do not allocate a third paint to a blend of two established paints.
    // Repeated flat colours and substantial shaded areas remain eligible.
    if (
      (entry.stable && entry.core >= (lossy ? Math.max(16, visiblePixels * 0.0005) : 4)) ||
      entry.count >= visiblePixels * 0.01 ||
      (solidCores.size <= 4 && entry.detail >= 4 && detailPaints < 2)
    )
      return false;
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
        if (p.reduce((sum, value, k) => sum + (value - a[k] - t * d[k]) ** 2, 0) < 32 ** 2)
          return true;
      }
    return false;
  };
  const limit = colors === "auto" ? 32 : colors;
  while (remaining.length && chosen.length < limit + Number(transparent)) {
    for (let i = remaining.length - 1; i >= 0; i--)
      if (
        chosen.some(
          (color) =>
            color.a > 0 &&
            distance(color, remaining[i].color) <
              (remaining[i].stable && remaining[i].core >= Math.max(16, visiblePixels * 0.0005)
                ? 12
                : 48),
        ) ||
        isEdgeBlend(remaining[i]) ||
        // Repeated opaque samples can be deliberate small lossless accents.
        (!remaining[i].stable &&
          remaining[i].detail === 0 &&
          (lossy || remaining[i].color.a !== 255 || remaining[i].peak < 4) &&
          remaining[i].core < 2 &&
          remaining[i].count < visiblePixels * 0.003)
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
    const next = remaining.splice(best, 1)[0];
    if (!next.stable && next.detail >= 4) detailPaints++;
    chosen.push(next.color);
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
  lossy: boolean,
  preserveDetail: boolean,
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
  // Flat artwork repeats exact RGBA values. Bound the cache for photographic inputs.
  const nearestColors = new Map<number, { best: number; error: number }>();
  for (let pixel = 0; pixel < count; pixel++) {
    const offset = pixel * 4;
    const key =
      ((data[offset] << 24) |
        (data[offset + 1] << 16) |
        (data[offset + 2] << 8) |
        data[offset + 3]) >>>
      0;
    const cached = nearestColors.get(key);
    let best = cached?.best ?? 0,
      error = cached?.error ?? Infinity;
    if (!cached) {
      for (let i = 0; i < palette.length; i++) {
        const value = distance(pixel, palette[i]);
        if (value < error) {
          best = i;
          error = value;
        }
      }
      if (nearestColors.size < 4096) nearestColors.set(key, { best, error });
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
      nearRgba(data, offset, offset - 4, 8, 8) &&
      nearRgba(data, offset, offset + 4, 8, 8) &&
      nearRgba(data, offset, offset - width * 4, 8, 8) &&
      nearRgba(data, offset, offset + width * 4, 8, 8);
    if (error <= 144 || flat || (preserveDetail && thinFeature(data, pixel, width))) {
      labels[pixel] = best;
      queue[tail++] = pixel;
    }
  }
  // Only boundary seeds can expand. Avoid scanning four neighbours and allocating
  // a frontier entry for every pixel in the already-labelled flat interiors.
  const seeded = tail;
  tail = 0;
  for (let i = 0; i < seeded; i++) {
    const p = queue[i],
      x = p % width;
    if (
      (x > 0 && labels[p - 1] === -1) ||
      (x < width - 1 && labels[p + 1] === -1) ||
      (p >= width && labels[p - width] === -1) ||
      (p < count - width && labels[p + width] === -1)
    )
      queue[tail++] = p;
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
  for (let pixel = 0; pixel < count; pixel++) if (labels[pixel] < 0) labels[pixel] = nearest[pixel];
  if (lossy) {
    const visited = new Uint8Array(count),
      replacements = new Int16Array(labels);
    for (let first = 0; first < count; first++) {
      if (visited[first]) continue;
      const label = labels[first],
        neighbors = new Map<number, number>();
      let read = 0,
        size = 1;
      queue[0] = first;
      visited[first] = 1;
      while (read < size) {
        const pixel = queue[read++],
          x = pixel % width;
        for (const next of [
          x > 0 ? pixel - 1 : -1,
          x < width - 1 ? pixel + 1 : -1,
          pixel >= width ? pixel - width : -1,
          pixel < count - width ? pixel + width : -1,
        ]) {
          if (next < 0) continue;
          if (labels[next] !== label) {
            neighbors.set(labels[next], (neighbors.get(labels[next]) ?? 0) + 1);
            continue;
          }
          if (!visited[next]) {
            visited[next] = 1;
            queue[size++] = next;
          }
        }
      }
      if (size > 64 || !palette[label].a) continue;
      let best = label,
        bestDistance = Infinity,
        contacts = 0;
      for (const [other, boundary] of neighbors) {
        const a = palette[label],
          b = palette[other];
        const delta =
          Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) + Math.abs(a.a - b.a);
        if (
          b.a &&
          delta <= 48 &&
          (delta < bestDistance || (delta === bestDistance && boundary > contacts))
        ) {
          best = other;
          bestDistance = delta;
          contacts = boundary;
        }
      }
      if (best !== label) for (let i = 0; i < size; i++) replacements[queue[i]] = best;
    }
    labels.set(replacements);
  }
  for (let pixel = 0; pixel < count; pixel++) {
    const color = palette[labels[pixel]];
    const i = pixel * 4;
    data[i] = color.r;
    data[i + 1] = color.g;
    data[i + 2] = color.b;
    data[i + 3] = color.a;
  }
}

export function prepareRasterRegions(
  image: RasterPixels,
  colors: TraceColors,
  lossy = false,
): TraceColor[] {
  resolveCoverage(image);
  const seeds = palette(image.data, colors, image.width, lossy);
  if (!seeds.some((color) => color.a > 0))
    throw new Error("This image has no visible pixels to trace.");
  separateRegions(image, seeds, lossy, !lossy && colors === "auto" && seeds.length <= 5);
  return seeds;
}
