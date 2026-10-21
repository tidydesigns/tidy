import { traceLimits, type RasterPixels, type RasterTrace } from "./contract";
import { serializeContours } from "@tidy/design/vector-geometry";

type Paint = NonNullable<RasterTrace["paths"][number]["fill"]>;
type Sample = { x: number; y: number; rgb: number[] };
type Model = {
  fill?: Paint;
  color: string;
  alpha: number;
  at: (x: number, y: number) => number[];
};
const hex = (rgb: number[]) =>
  `#${rgb
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

function solve(matrix: number[][], values: number[]): number[] | undefined {
  const rows = matrix.map((row, i) => [...row, values[i]]);
  for (let i = 0; i < values.length; i++) {
    let pivot = i;
    for (let j = i + 1; j < rows.length; j++)
      if (Math.abs(rows[j][i]) > Math.abs(rows[pivot][i])) pivot = j;
    [rows[i], rows[pivot]] = [rows[pivot], rows[i]];
    if (Math.abs(rows[i][i]) < 1e-8) return;
    const divisor = rows[i][i];
    for (let k = i; k <= values.length; k++) rows[i][k] /= divisor;
    for (let j = 0; j < rows.length; j++) {
      if (j === i) continue;
      const scale = rows[j][i];
      for (let k = i; k <= values.length; k++) rows[j][k] -= scale * rows[i][k];
    }
  }
  return rows.map((row) => row[values.length]);
}

/** Fit a bounded piecewise-linear colour profile. The stops are measured from
 * source pixels, then simplified in colour space; they are not quantised bands. */
function profile(samples: Sample[], project: (x: number, y: number) => number) {
  const positions = samples.map((s) => project(s.x, s.y));
  const minimum = Math.min(...positions),
    maximum = Math.max(...positions);
  if (maximum - minimum < 1e-4) return;
  const bins = Array.from({ length: 64 }, () => ({ n: 0, t: 0, rgb: [0, 0, 0, 0] }));
  samples.forEach((sample, i) => {
    const t = (positions[i] - minimum) / (maximum - minimum);
    const bin = bins[Math.min(63, Math.floor(t * 64))];
    bin.n++;
    bin.t += t;
    for (let k = 0; k < 4; k++) bin.rgb[k] += sample.rgb[k];
  });
  const knots = bins
    .filter((b) => b.n)
    .map((b) => ({ t: b.t / b.n, rgb: b.rgb.map((v) => v / b.n) }));
  if (knots.length < 4) return;
  const interpolate = (a: (typeof knots)[number], b: (typeof knots)[number], t: number) =>
    a.rgb.map((v, k) => v + ((b.rgb[k] - v) * (t - a.t)) / (b.t - a.t));
  if (knots[0].t > 0) knots.unshift({ t: 0, rgb: interpolate(knots[0], knots[1], 0) });
  if (knots.at(-1)!.t < 1) knots.push({ t: 1, rgb: interpolate(knots.at(-2)!, knots.at(-1)!, 1) });
  const keep = new Set([0, knots.length - 1]);
  const simplify = (first: number, last: number) => {
    let worst = 1.2,
      index = -1;
    for (let i = first + 1; i < last; i++) {
      const rgb = interpolate(knots[first], knots[last], knots[i].t);
      const error = Math.max(
        ...rgb.map((v, k) => Math.abs(v - knots[i].rgb[k]) * (k === 3 ? 1 : knots[i].rgb[3] / 255)),
      );
      if (error > worst) {
        worst = error;
        index = i;
      }
    }
    if (index !== -1) {
      keep.add(index);
      simplify(first, index);
      simplify(index, last);
    }
  };
  simplify(0, knots.length - 1);
  const stops = [...keep].sort((a, b) => a - b).map((i) => knots[i]);
  if (stops.length > 20) return;
  const at = (x: number, y: number) => {
    const t = Math.max(0, Math.min(1, (project(x, y) - minimum) / (maximum - minimum)));
    const right = stops.findIndex((s) => s.t >= t);
    const i = Math.max(1, right < 0 ? stops.length - 1 : right);
    return interpolate(stops[i - 1], stops[i], t).map((v) => Math.max(0, Math.min(255, v)));
  };
  let total = 0,
    worst = 0;
  for (const sample of samples) {
    const rgb = at(sample.x, sample.y);
    for (let k = 0; k < 4; k++) {
      const error = Math.abs(rgb[k] - sample.rgb[k]) * (k === 3 ? 1 : sample.rgb[3] / 255);
      total += error;
      worst = Math.max(worst, error);
    }
  }
  if (!Number.isFinite(total) || total / (samples.length * 4) > 1.6 || worst > 10) return;
  return { minimum, maximum, stops, at };
}

function fitRegion(
  image: RasterPixels,
  pixels: number[],
  labels: Int16Array,
  label: number,
): Model | undefined {
  const { width, height, data } = image;
  const samples: Sample[] = [];
  const stride = Math.max(1, Math.floor(pixels.length / 8192));
  const low = [255, 255, 255, 255],
    high = [0, 0, 0, 0],
    sum = [0, 0, 0, 0];
  for (let i = 0; i < pixels.length; i += stride) {
    const p = pixels[i],
      rgb = [data[p * 4], data[p * 4 + 1], data[p * 4 + 2], data[p * 4 + 3]];
    samples.push({ x: (p % width) + 0.5, y: Math.floor(p / width) + 0.5, rgb });
    for (let k = 0; k < 4; k++) {
      low[k] = Math.min(low[k], rgb[k]);
      high[k] = Math.max(high[k], rgb[k]);
      sum[k] += rgb[k];
    }
  }
  const varyingAlpha = high[3] - low[3] > 4;
  const alpha = varyingAlpha ? 255 : data[pixels[0] * 4 + 3],
    mean = sum.map((v) => v / samples.length);
  if (high.every((v, k) => v - low[k] <= 4))
    return { color: hex(mean.slice(0, 3)), alpha, at: () => mean };
  if (pixels.length < 128) return;
  let xx = 0,
    xy = 0,
    yy = 0;
  const matrix = Array.from({ length: 4 }, () => [0, 0, 0, 0]),
    values = [0, 0, 0, 0],
    scale = Math.max(width, height);
  for (let i = 0; i < pixels.length; i += stride) {
    const p = pixels[i],
      x = p % width,
      y = Math.floor(p / width);
    if (
      x < 6 ||
      y < 6 ||
      x >= width - 6 ||
      y >= height - 6 ||
      [p - 6, p + 6, p - 6 * width, p + 6 * width].some((n) => labels[n] !== label)
    )
      continue;
    for (let k = 0; k < 4; k++) {
      const gx = (data[(p + 6) * 4 + k] - data[(p - 6) * 4 + k]) / 12;
      const gy = (data[(p + 6 * width) * 4 + k] - data[(p - 6 * width) * 4 + k]) / 12;
      xx += gx * gx;
      xy += gx * gy;
      yy += gy * gy;
      const length = Math.hypot(gx, gy);
      if (length < 0.3) continue;
      // The normal is parallel to Q*(point-centre). Solve a symmetric conic
      // including its cross term, so rotated ellipses retain one editable paint.
      const dx = gx,
        dy = gy,
        nx = (x + 0.5) / scale,
        ny = (y + 0.5) / scale;
      const row = [dy * nx, dy * ny - dx * nx, dy, -dx],
        target = dx * ny;
      for (let a = 0; a < 4; a++) {
        values[a] += row[a] * target;
        for (let b = 0; b < 4; b++) matrix[a][b] += row[a] * row[b];
      }
    }
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy),
    ux = Math.cos(angle),
    uy = Math.sin(angle);
  const linear = profile(samples, (x, y) => x * ux + y * uy);
  if (linear) {
    const middle = { x: width / 2, y: height / 2 },
      origin = middle.x * ux + middle.y * uy;
    const point = (t: number) => ({
      x: (middle.x + (t - origin) * ux) / width,
      y: (middle.y + (t - origin) * uy) / height,
    });
    return {
      color: hex(mean.slice(0, 3)),
      alpha,
      at: linear.at,
      fill: {
        id: "trace-fill",
        type: "linear",
        visible: true,
        opacity: 1,
        angle: 0,
        start: point(linear.minimum),
        end: point(linear.maximum),
        stops: linear.stops.map((s, i) => ({
          id: `stop-${i}`,
          position: s.t,
          color: hex(s.rgb.slice(0, varyingAlpha ? 4 : 3)),
        })),
      },
    };
  }
  const solution = solve(matrix, values);
  if (!solution) return;
  const [a, b, d, e] = solution,
    determinant = a - b * b;
  if (a <= 0 || determinant <= 1e-4) return;
  const cx = (b * e - d) / determinant,
    cy = (b * d - a * e) / determinant,
    theta = Math.atan2(2 * b, a - 1) / 2,
    spread = Math.hypot(a - 1, 2 * b),
    eigenX = (a + 1 + spread) / 2,
    eigenY = (a + 1 - spread) / 2;
  if (eigenY <= 0 || eigenX / eigenY > 100 || cx < -2 || cx > 3 || cy < -2 || cy > 3) return;
  const radial = profile(samples, (x, y) => {
    const dx = x / scale - cx,
      dy = y / scale - cy;
    return Math.sqrt(Math.max(0, a * dx * dx + 2 * b * dx * dy + dy * dy));
  });
  if (!radial) return;
  const last = radial.stops.at(-1)!,
    previous = radial.stops.at(-2)!;
  // A clipped gradient may have a large constant-colour exterior. Its final
  // plateau does not need to inflate the editable ellipse beyond paint limits.
  const extent = last.rgb.every((v, k) => Math.abs(v - previous.rgb[k]) <= 1.2)
    ? radial.minimum + previous.t * (radial.maximum - radial.minimum)
    : radial.maximum;
  const radiusX = (extent * scale) / Math.sqrt(eigenX) / width,
    radiusY = (extent * scale) / Math.sqrt(eigenY) / height;
  if (radiusX > 3 || radiusY > 3) return;
  return {
    color: hex(mean.slice(0, 3)),
    alpha,
    at: radial.at,
    fill: {
      id: "trace-fill",
      type: "radial",
      visible: true,
      opacity: 1,
      centerX: (cx * scale) / width,
      centerY: (cy * scale) / height,
      radiusX,
      radiusY,
      rotation: (theta * 180) / Math.PI,
      stops: radial.stops
        .filter((s) => radial.minimum + s.t * (radial.maximum - radial.minimum) <= extent + 1e-6)
        .map((s, i) => ({
          id: `stop-${i}`,
          position: Math.max(
            0,
            Math.min(1, (radial.minimum + s.t * (radial.maximum - radial.minimum)) / extent),
          ),
          color: hex(s.rgb.slice(0, varyingAlpha ? 4 : 3)),
        })),
    },
  };
}

/** Separate smooth interiors before palette reduction so a gradient remains one
 * editable paint. Decline ambiguous/textured inputs; the existing tracer remains
 * the fallback and pixel verification still chooses the faithful candidate. */
export function traceGradientRegions(
  image: RasterPixels,
  traceMask: (mask: RasterPixels) => RasterTrace,
): RasterTrace | undefined {
  const { width, height, data } = image,
    count = width * height;
  const labels = new Int16Array(count).fill(-1),
    core = new Uint8Array(count),
    queue = new Int32Array(count);
  const neighbors = (p: number) => [
    p % width > 0 ? p - 1 : -1,
    p % width < width - 1 ? p + 1 : -1,
    p >= width ? p - width : -1,
    p < count - width ? p + width : -1,
  ];
  const similar = (p: number, q: number) => {
    const a = p * 4,
      b = q * 4;
    return (
      Math.abs(data[a + 3] - data[b + 3]) <= 6 &&
      Math.abs(data[a] - data[b]) <= 6 &&
      Math.abs(data[a + 1] - data[b + 1]) <= 6 &&
      Math.abs(data[a + 2] - data[b + 2]) <= 6
    );
  };
  for (let p = 0; p < count; p++) {
    if (!data[p * 4 + 3]) continue;
    const x = p % width;
    if (
      (x === 0 || similar(p, p - 1)) &&
      (x === width - 1 || similar(p, p + 1)) &&
      (p < width || similar(p, p - width)) &&
      (p >= count - width || similar(p, p + width))
    )
      core[p] = 1;
  }
  const regions: number[][] = [];
  for (let first = 0; first < count; first++) {
    if (!core[first] || labels[first] !== -1) continue;
    const label = regions.length;
    let head = 0,
      tail = 1;
    queue[0] = first;
    labels[first] = label;
    while (head < tail) {
      const p = queue[head++];
      for (const q of neighbors(p))
        if (q >= 0 && core[q] && labels[q] === -1 && similar(p, q)) {
          labels[q] = label;
          queue[tail++] = q;
        }
    }
    if (tail < 32) {
      for (let i = 0; i < tail; i++) labels[queue[i]] = -2;
      continue;
    }
    if (regions.length >= 32) return;
    regions.push(Array.from(queue.subarray(0, tail)));
  }
  const fitted: Model[] = [];
  for (const [label, pixels] of regions.entries()) {
    const model = fitRegion(image, pixels, labels, label);
    if (!model) return;
    fitted.push(model);
  }
  if (!fitted.some((model) => model.fill)) return;
  let head = 0,
    tail = 0;
  for (let p = 0; p < count; p++) if (labels[p] >= 0) queue[tail++] = p;
  // Expand only into neighbouring interiors; disconnected small features cannot
  // acquire an unrelated paint from elsewhere in the image.
  while (head < tail) {
    const p = queue[head++];
    for (const q of neighbors(p)) {
      if (q < 0 || labels[q] >= 0 || !data[q * 4 + 3]) continue;
      let best = labels[p],
        distance = Infinity;
      for (const n of neighbors(q)) {
        if (n < 0 || labels[n] < 0) continue;
        const label = labels[n],
          rgb = fitted[label].at((q % width) + 0.5, Math.floor(q / width) + 0.5);
        const error = rgb.reduce((s, v, k) => s + (v - data[q * 4 + k]) ** 2, 0);
        if (error < distance) {
          best = label;
          distance = error;
        }
      }
      labels[q] = best;
      queue[tail++] = q;
    }
  }
  // Thin details may have no four-neighbour interior. Recover pixels the smooth
  // paints cannot explain, excluding ordinary antialias blends at shared edges.
  const residual = new Uint8Array(count);
  for (let p = 0; p < count; p++) {
    if (labels[p] < 0 || data[p * 4 + 3] !== fitted[labels[p]].alpha) continue;
    const x = (p % width) + 0.5,
      y = Math.floor(p / width) + 0.5;
    const rgb = [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]],
      base = fitted[labels[p]].at(x, y);
    if (rgb.every((v, k) => Math.abs(v - base[k]) <= 10)) continue;
    let boundary = false;
    for (let dy = -2; dy <= 2 && !boundary; dy++)
      for (let dx = -2; dx <= 2 && !boundary; dx++) {
        const xx = (p % width) + dx,
          yy = Math.floor(p / width) + dy;
        if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
        const other = labels[yy * width + xx];
        if (other >= 0 && other !== labels[p]) boundary = true;
      }
    if (!boundary) residual[p] = 1;
  }
  let residualPixels = 0;
  for (let p = 0; p < count; p++)
    if (residual[p]) {
      residualPixels++;
    }
  if (residualPixels > count * 0.01) return;
  const mask = new Uint8ClampedArray(data.length);
  for (let p = 0; p < count; p++) {
    if (!data[p * 4 + 3]) continue;
    const label = labels[p];
    if (label < 0) return; // An unseeded thin stroke or isolated accent: preserve the original trace.
    const model = fitted[label];
    mask.set(
      [
        (label % 4) * 64 + 32,
        (Math.floor(label / 4) % 4) * 64 + 32,
        Math.floor(label / 16) * 64 + 32,
        data[p * 4 + 3] >=
        (model.at((p % width) + 0.5, Math.floor(p / width) + 0.5)[3] ?? model.alpha) / 2
          ? model.alpha
          : 0,
      ],
      p * 4,
    );
  }
  let geometry: RasterTrace;
  try {
    geometry = traceMask({ width, height, data: mask });
  } catch {
    // An optional model must never make otherwise traceable artwork fail its
    // geometry/point budget. The normal palette tracer is still available.
    return;
  }
  const paint = (path: RasterTrace["paths"][number]) => {
    const rgb = [1, 3, 5].map((i) => parseInt(path.color.slice(i, i + 2), 16));
    const label =
      Math.round((rgb[0] - 32) / 64) +
      Math.round((rgb[1] - 32) / 64) * 4 +
      Math.round((rgb[2] - 32) / 64) * 16;
    const model = fitted[label];
    return { ...path, color: model.color, fill: model.fill, opacity: model.alpha / 255 };
  };
  const paths: RasterTrace["paths"] = geometry.paths.map(paint);
  if (residualPixels) {
    // Preserve coverage of sparse subpixel marks exactly as horizontal runs.
    // Fitting these one-pixel strips to triangles/curves can erase their ends.
    const groups = new Map<
      number,
      {
        sums: number[];
        count: number;
        contours: NonNullable<RasterTrace["paths"][number]["vectorPath"]["contours"]>;
      }
    >();
    const key = (p: number) =>
      ((data[p * 4] >> 4) << 12) |
      ((data[p * 4 + 1] >> 4) << 8) |
      ((data[p * 4 + 2] >> 4) << 4) |
      (data[p * 4 + 3] >> 4);
    for (let p = 0; p < count; p++) {
      if (!residual[p]) continue;
      const first = p,
        color = key(p),
        y = Math.floor(p / width),
        x = p % width;
      while (p + 1 < (y + 1) * width && residual[p + 1] && key(p + 1) === color) p++;
      let group = groups.get(color);
      if (!group) {
        group = { sums: [0, 0, 0, 0], count: 0, contours: [] };
        groups.set(color, group);
      }
      for (let pixel = first; pixel <= p; pixel++) {
        group.count++;
        for (let k = 0; k < 4; k++) group.sums[k] += data[pixel * 4 + k];
      }
      const id = `detail-${color}-${group.contours.length}`,
        right = (p % width) + 1;
      group.contours.push({
        id,
        closed: true,
        points: [
          { id: `${id}-0`, x, y },
          { id: `${id}-1`, x: right, y },
          { id: `${id}-2`, x: right, y: y + 1 },
          { id: `${id}-3`, x, y: y + 1 },
        ],
      });
      if (group.contours.length > 100 || groups.size > 64) return;
    }
    for (const group of groups.values())
      paths.push({
        color: hex(group.sums.slice(0, 3).map((v) => v / group.count)),
        opacity: group.sums[3] / group.count / 255,
        vectorPath: {
          d: serializeContours(group.contours),
          contours: group.contours,
          viewBox: { x: 0, y: 0, width, height },
          fillRule: "evenodd",
        },
      });
  }
  if (paths.length > traceLimits.paths) return;
  // Independently antialiased neighbours leave hairline transparency even when
  // their contours meet. Recover the opaque image background beneath them, just
  // as primitive recovery does for an icon behind its foreground decoration.
  let opaque = true;
  for (let i = 3; i < data.length; i += 4)
    if (data[i] !== 255) {
      opaque = false;
      break;
    }
  if (opaque) {
    const corners = [0, width - 1, count - width, count - 1].map((p) => labels[p]);
    const background = corners.find((label) => corners.filter((v) => v === label).length >= 2);
    if (background !== undefined) {
      const model = fitted[background];
      const index = paths.findIndex((p) => p.fill === model.fill && p.color === model.color);
      if (index >= 0) {
        const contour = {
          id: "trace-background",
          closed: true,
          points: [
            { id: "bg-0", x: 0, y: 0 },
            { id: "bg-1", x: width, y: 0 },
            { id: "bg-2", x: width, y: height },
            { id: "bg-3", x: 0, y: height },
          ],
        };
        const [path] = paths.splice(index, 1);
        paths.unshift({
          ...path,
          name: "Rectangle",
          vectorPath: { ...path.vectorPath, d: serializeContours([contour]), contours: [contour] },
        });
      }
    }
  }
  for (const path of paths) {
    if (path.fill?.type !== "radial") continue;
    const points = path.vectorPath.contours!.flatMap((c) =>
      c.points.flatMap((p) => [p, ...(p.in ? [p.in] : []), ...(p.out ? [p.out] : [])]),
    );
    const x = Math.min(...points.map((p) => p.x)),
      y = Math.min(...points.map((p) => p.y));
    const w = Math.max(...points.map((p) => p.x)) - x,
      h = Math.max(...points.map((p) => p.y)) - y;
    const cx = (path.fill.centerX * width - x) / w,
      cy = (path.fill.centerY * height - y) / h;
    const rx = (path.fill.radiusX * width) / w,
      ry = (path.fill.radiusY * height) / h;
    if (
      ![cx, cy, rx, ry].every(Number.isFinite) ||
      cx < -3 ||
      cx > 4 ||
      cy < -3 ||
      cy > 4 ||
      rx < 0.001 ||
      rx > 3 ||
      ry < 0.001 ||
      ry > 3
    )
      return;
  }
  return {
    ...geometry,
    paths,
    pointCount: paths.reduce(
      (sum, p) => sum + p.vectorPath.contours!.reduce((n, c) => n + c.points.length, 0),
      0,
    ),
    fallback: undefined,
  };
}
