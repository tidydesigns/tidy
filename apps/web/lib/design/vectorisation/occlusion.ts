import {
  serializeContours,
  type VectorContour,
  type VectorPoint,
} from "@bella/design/vector-geometry";
import { fitRasterShape, sampleRasterContour } from "./shape-fit";
import type { RasterTrace } from "./contract";

type Path = RasterTrace["paths"][number];
const cross = (a: VectorPoint, b: VectorPoint, c: VectorPoint) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function hull(points: VectorPoint[]): VectorPoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const half = (points: VectorPoint[]) => {
    const out: VectorPoint[] = [];
    for (const point of points) {
      while (out.length > 1 && cross(out.at(-2)!, out.at(-1)!, point) <= 0) out.pop();
      out.push(point);
    }
    return out;
  };
  return [...half(sorted).slice(0, -1), ...half(sorted.reverse()).slice(0, -1)];
}
const area = (points: VectorPoint[]) =>
  Math.abs(
    points.reduce((sum, p, i) => {
      const next = points[(i + 1) % points.length];
      return sum + p.x * next.y - next.x * p.y;
    }, 0),
  ) / 2;
const paintKey = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;

/** Recover only convex geometric shapes whose missing interior is demonstrably
 * occupied by smaller opaque paints. Never invent pixels through transparency
 * or bridge separate objects through the larger background. No subject recognition.
 */
export function recoverRasterOcclusion(
  paths: Path[],
  image: { width: number; height: number; data: Uint8ClampedArray },
): Path[] {
  const paints = new Map<number, number>();
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] !== 255) continue;
    const key = paintKey(image.data[i], image.data[i + 1], image.data[i + 2]);
    paints.set(key, (paints.get(key) ?? 0) + 1);
  }
  const geometry = new Map<Path, { samples: VectorPoint[]; hull: VectorPoint[]; area: number }>();
  const measure = (path: Path) => {
    let cached = geometry.get(path);
    if (!cached) {
      const samples = sampleRasterContour(path.vectorPath.contours![0]);
      const boundary = hull(samples);
      cached = { samples, hull: boundary, area: area(boundary) };
      geometry.set(path, cached);
    }
    return cached;
  };
  const removed = new Set<Path>();
  const output: Path[] = [];
  for (const path of paths) {
    if (
      removed.has(path) ||
      path.opacity !== 1 ||
      (path.name && path.name !== "Polygon" && path.name !== "Triangle")
    ) {
      if (!removed.has(path)) output.push(path);
      continue;
    }
    const siblings = paths.filter(
      (p) => p.opacity === 1 && p.color === path.color && !removed.has(p),
    );
    const all = hull(siblings.flatMap((p) => measure(p).samples));
    // Collapse near-collinear raster artefacts before testing a triangle hypothesis.
    const triangle = [...all];
    let changed = true;
    while (changed && triangle.length > 3) {
      changed = false;
      for (let i = 0; i < triangle.length; i++) {
        const a = triangle[(i + triangle.length - 1) % triangle.length],
          b = triangle[i],
          c = triangle[(i + 1) % triangle.length];
        if (Math.abs(cross(a, c, b)) / Math.max(0.01, Math.hypot(c.x - a.x, c.y - a.y)) <= 1.8) {
          triangle.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    const id = path.vectorPath.contours![0].id;
    const makeContour = (points: VectorPoint[]): VectorContour => ({
      id,
      closed: true,
      points: points.map((p, i) => ({ ...p, id: `${id}-${i}` })),
    });
    let candidate: { contour: VectorContour; name?: string },
      boundary: VectorPoint[],
      merge = false;
    if (triangle.length === 3 && siblings.length <= 8) {
      candidate = { contour: makeContour(triangle), name: "Triangle" };
      boundary = triangle;
      merge = true;
    } else {
      const own = measure(path).hull;
      candidate = fitRasterShape(makeContour(own));
      boundary = own;
      if (!["Ellipse", "Rectangle", "Rounded rectangle"].includes(candidate.name ?? "")) {
        output.push(path);
        continue;
      }
    }
    const candidateArea = area(boundary);
    if (candidateArea < 64) {
      output.push(path);
      continue;
    }
    const left = Math.max(0, Math.floor(Math.min(...boundary.map((p) => p.x)))),
      right = Math.min(image.width - 1, Math.ceil(Math.max(...boundary.map((p) => p.x))));
    const top = Math.max(0, Math.floor(Math.min(...boundary.map((p) => p.y)))),
      bottom = Math.min(image.height - 1, Math.ceil(Math.max(...boundary.map((p) => p.y))));
    const pathColor = Number.parseInt(path.color.slice(1), 16);
    let allowed = true,
      uncertain = 0;
    for (let y = top; y <= bottom && allowed; y++)
      for (let x = left; x <= right; x++) {
        const pixel = { x: x + 0.5, y: y + 0.5 };
        // Ignore a narrow boundary band where raster coverage is uncertain.
        const inside = boundary.every((p, i) => {
          const next = boundary[(i + 1) % boundary.length];
          return cross(p, next, pixel) > 1.5 * Math.hypot(next.x - p.x, next.y - p.y);
        });
        if (!inside) continue;
        const offset = (y * image.width + x) * 4;
        const color = paintKey(image.data[offset], image.data[offset + 1], image.data[offset + 2]);
        if (color !== pathColor) {
          if (image.data[offset + 3] !== 255) {
            allowed = false;
            break;
          }
          // A handful of ambiguous edge pixels must not block a clear occlusion.
          // Larger background gaps still prevent joining unrelated objects.
          if ((paints.get(color) ?? Infinity) >= candidateArea && ++uncertain > 4) {
            allowed = false;
            break;
          }
        }
      }
    if (!allowed) {
      output.push(path);
      continue;
    }
    if (merge) for (const sibling of siblings) if (sibling !== path) removed.add(sibling);
    output.push({
      ...path,
      name: candidate.name,
      vectorPath: {
        ...path.vectorPath,
        contours: [candidate.contour],
        d: serializeContours([candidate.contour]),
      },
    });
  }
  // Draw recovered opaque backgrounds below smaller paints, but never move a
  // paint across a translucent layer: its compositing order must stay intact.
  const kept = output.filter((p) => !removed.has(p));
  for (let start = 0; start < kept.length;) {
    if (kept[start].opacity !== 1) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < kept.length && kept[end].opacity === 1) end++;
    kept.splice(
      start,
      end - start,
      ...kept.slice(start, end).sort((a, b) => measure(b).area - measure(a).area),
    );
    start = end;
  }
  return kept;
}
