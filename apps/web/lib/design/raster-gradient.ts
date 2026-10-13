import type { DesignPaint } from "./document";
import type { RasterPixels } from "./raster-trace-contract";

type LinearPaint = Extract<DesignPaint, { type: "linear" }>;
/** Conservative single-region, two-stop gradient model. Fit colour planes, require
 * their spatial directions to agree, then verify residuals against every interior
 * pixel. Multi-region shading, radial gradients and photos decline this model. */
export function fitRasterLinearGradient(
  image: RasterPixels,
): { fill: LinearPaint; opacity: number } | undefined {
  const { width, height, data } = image;
  let alpha = 0;
  for (let i = 3; i < data.length; i += 4) alpha = Math.max(alpha, data[i]);
  if (!alpha) return;
  const samples: { x: number; y: number; rgb: number[] }[] = [];
  let count = 0,
    sx = 0,
    sy = 0,
    sxx = 0,
    syy = 0,
    sxy = 0;
  const sums = [0, 0, 0],
    xs = [0, 0, 0],
    ys = [0, 0, 0];
  const stride = Math.max(1, Math.ceil((width * height) / 8192));
  for (let pixel = 0; pixel < width * height; pixel += stride) {
    const i = pixel * 4;
    if (data[i + 3] !== alpha) continue;
    const x = ((pixel % width) + 0.5) / width,
      y = (Math.floor(pixel / width) + 0.5) / height;
    const rgb = [data[i], data[i + 1], data[i + 2]];
    samples.push({ x, y, rgb });
    count++;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    for (let k = 0; k < 3; k++) {
      sums[k] += rgb[k];
      xs[k] += x * rgb[k];
      ys[k] += y * rgb[k];
    }
  }
  if (count < 64) return;
  const mx = sx / count,
    my = sy / count,
    xx = sxx - sx * mx,
    yy = syy - sy * my,
    xy = sxy - sx * my;
  const determinant = xx * yy - xy * xy;
  if (determinant < 0.000001) return;
  const planes = sums.map((sum, k) => {
    const cx = xs[k] - sum * mx,
      cy = ys[k] - sum * my;
    const a = (cx * yy - cy * xy) / determinant,
      b = (cy * xx - cx * xy) / determinant;
    return { a, b, c: sum / count - a * mx - b * my };
  });
  const strongest = [...planes].sort(
    (a, b) => Math.hypot(b.a / width, b.b / height) - Math.hypot(a.a / width, a.b / height),
  )[0];
  const length = Math.hypot(strongest.a / width, strongest.b / height);
  if (length * Math.min(width, height) < 12) return;
  const ux = strongest.a / width / length,
    uy = strongest.b / height / length;
  if (
    planes.some(
      (p) => Math.abs((-p.a / width) * uy + (p.b / height) * ux) * Math.hypot(width, height) > 2,
    )
  )
    return;
  let total = 0,
    maximum = 0;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const i = pixel * 4;
    if (!data[i + 3]) continue;
    // Interior alpha must be one constant fill, apart from a narrow coverage edge.
    if (data[i + 3] < alpha - 1) {
      const x = pixel % width,
        y = Math.floor(pixel / width);
      if (
        x > 0 &&
        x < width - 1 &&
        y > 0 &&
        y < height - 1 &&
        [-1, 1, -width, width].every(
          (offset) => Math.abs(data[i + offset * 4 + 3] - data[i + 3]) <= 1,
        )
      )
        return;
      continue;
    }
    const x = ((pixel % width) + 0.5) / width,
      y = (Math.floor(pixel / width) + 0.5) / height;
    for (let k = 0; k < 3; k++) {
      const error = Math.abs(planes[k].a * x + planes[k].b * y + planes[k].c - data[i + k]);
      total += error;
      maximum = Math.max(maximum, error);
    }
  }
  const interior = data.filter((_, i) => i % 4 === 3 && data[i] >= alpha - 1).length;
  if (maximum > 6 || total / Math.max(1, interior * 3) > 1.5) return;
  const projections = samples.map((p) => (p.x - mx) * width * ux + (p.y - my) * height * uy);
  const minimum = Math.min(...projections),
    maximumProjection = Math.max(...projections);
  const point = (t: number) => ({ x: mx + (t * ux) / width, y: my + (t * uy) / height });
  const start = point(minimum),
    end = point(maximumProjection);
  const color = (p: { x: number; y: number }) =>
    `#${planes
      .map((plane) =>
        Math.max(0, Math.min(255, Math.round(plane.a * p.x + plane.b * p.y + plane.c)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
  return {
    opacity: alpha / 255,
    fill: {
      id: "trace-fill",
      type: "linear",
      opacity: 1,
      visible: true,
      angle: 0,
      start,
      end,
      stops: [
        { id: "start", position: 0, color: color(start) },
        { id: "end", position: 1, color: color(end) },
      ],
    },
  };
}
