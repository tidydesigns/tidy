import {
  serializeContours,
  type VectorContour,
  type VectorAnchor,
  type VectorPoint,
} from "@tidy/design/vector-geometry";
import type { RasterTrace } from "./contract";

type Cubic = readonly [VectorPoint, VectorPoint, VectorPoint, VectorPoint];
type Sample = { point: VectorPoint; t: number };
const tolerance = 0.2;
const distance = (a: VectorPoint, b: VectorPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const subtract = (a: VectorPoint, b: VectorPoint): VectorPoint => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: VectorPoint, b: VectorPoint) => a.x * b.x + a.y * b.y;
function unit(a: VectorPoint): VectorPoint | undefined {
  const length = Math.hypot(a.x, a.y);
  return length > 0.000001 ? { x: a.x / length, y: a.y / length } : undefined;
}
function segment(a: VectorAnchor, b: VectorAnchor): Cubic {
  if (a.out || b.in) return [a, a.out ?? a, b.in ?? b, b];
  return [
    a,
    { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 },
    { x: b.x + (a.x - b.x) / 3, y: b.y + (a.y - b.y) / 3 },
    b,
  ];
}
function at([a, b, c, d]: Cubic, t: number): VectorPoint {
  const u = 1 - t;
  return {
    x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x,
    y: u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y,
  };
}
function sample(curve: Cubic): VectorPoint[] | undefined {
  const length =
    distance(curve[0], curve[1]) + distance(curve[1], curve[2]) + distance(curve[2], curve[3]);
  if (length > 128) return;
  const count = Math.max(8, Math.ceil(length));
  return Array.from({ length: count + 1 }, (_, i) => at(curve, i / count));
}
function fit(points: VectorPoint[], start: Cubic, end: Cubic): Cubic | undefined {
  if (points.length > 256) return;
  const a = start[0],
    d = end[3];
  const left = unit(subtract(start[1], a)),
    right = unit(subtract(end[2], d));
  if (!left || !right || distance(a, d) < 2) return;
  let length = 0;
  const samples: Sample[] = points.map((point, i) => {
    if (i) length += distance(points[i - 1], point);
    return { point, t: length };
  });
  if (length < 2) return;
  for (const s of samples) s.t /= length;
  let result: Cubic | undefined;
  for (let iteration = 0; iteration < 4; iteration++) {
    let aa = 0,
      ab = 0,
      bb = 0,
      ax = 0,
      bx = 0;
    for (const { point, t } of samples) {
      const u = 1 - t,
        b1 = 3 * u * u * t,
        b2 = 3 * u * t * t;
      const residual = {
        x: point.x - (u ** 3 + b1) * a.x - (b2 + t ** 3) * d.x,
        y: point.y - (u ** 3 + b1) * a.y - (b2 + t ** 3) * d.y,
      };
      aa += b1 * b1;
      ab += b1 * b2 * dot(left, right);
      bb += b2 * b2;
      ax += b1 * dot(left, residual);
      bx += b2 * dot(right, residual);
    }
    const determinant = aa * bb - ab * ab;
    if (Math.abs(determinant) < 0.00000001) return;
    const alpha = (ax * bb - bx * ab) / determinant,
      beta = (bx * aa - ax * ab) / determinant;
    if (
      !Number.isFinite(alpha + beta) ||
      Math.min(alpha, beta) <= 0 ||
      Math.max(alpha, beta) > length
    )
      return;
    const b = { x: a.x + left.x * alpha, y: a.y + left.y * alpha };
    const c = { x: d.x + right.x * beta, y: d.y + right.y * beta };
    result = [a, b, c, d];
    let previous = -1;
    for (const s of samples) {
      const t = s.t,
        u = 1 - t,
        point = at(result, t);
      const first = {
        x: 3 * u * u * (b.x - a.x) + 6 * u * t * (c.x - b.x) + 3 * t * t * (d.x - c.x),
        y: 3 * u * u * (b.y - a.y) + 6 * u * t * (c.y - b.y) + 3 * t * t * (d.y - c.y),
      };
      const second = {
        x: 6 * u * (c.x - 2 * b.x + a.x) + 6 * t * (d.x - 2 * c.x + b.x),
        y: 6 * u * (c.y - 2 * b.y + a.y) + 6 * t * (d.y - 2 * c.y + b.y),
      };
      const delta = subtract(point, s.point),
        denominator = dot(first, first) + dot(delta, second);
      const next =
        denominator > 0.000001 ? Math.max(0, Math.min(1, t - dot(delta, first) / denominator)) : t;
      if (next <= previous) return;
      s.t = next;
      previous = next;
    }
  }
  if (!result || samples.some((s) => distance(at(result, s.t), s.point) > tolerance)) return;
  const fitted = sample(result);
  if (!fitted) return;
  for (const point of fitted) {
    let closest = Infinity;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        edge = subtract(points[i], a),
        delta = subtract(point, a);
      const size = dot(edge, edge),
        t = size ? Math.max(0, Math.min(1, dot(delta, edge) / size)) : 0;
      closest = Math.min(closest, Math.hypot(delta.x - edge.x * t, delta.y - edge.y * t));
    }
    if (closest > tolerance) return;
  }
  return result;
}

function simplifyContour(contour: VectorContour, budget: { remaining: number }): VectorContour {
  if (contour.points.length < 5) return contour;
  const points = contour.points.map((point) => ({ ...point }));
  let index = 0,
    original: VectorPoint[] | undefined;
  while (index + 2 < points.length && points.length > (contour.closed ? 3 : 2)) {
    const a = points[index],
      b = points[index + 1],
      c = points[index + 2];
    const first = segment(a, b),
      second = segment(b, c);
    const incoming = unit(subtract(b, first[2])) ?? unit(subtract(b, first[1]));
    const outgoing = unit(subtract(second[1], b)) ?? unit(subtract(second[2], b));
    if (!incoming || !outgoing || dot(incoming, outgoing) < 0.94) {
      index++;
      original = undefined;
      continue;
    }
    if (budget.remaining-- <= 0) break;
    const head = original ?? sample(first),
      tail = sample(second);
    const samples = head && tail ? [...head, ...tail.slice(1)] : undefined;
    const merged = samples && fit(samples, first, second);
    if (!merged || !samples) {
      index++;
      original = undefined;
      continue;
    }
    const chord = subtract(c, a),
      span = Math.hypot(chord.x, chord.y);
    const straight = [merged[1], merged[2]].every(
      (point) => Math.abs((point.x - a.x) * chord.y - (point.y - a.y) * chord.x) <= span * 0.000001,
    );
    points[index] = { ...a, out: straight ? undefined : merged[1] };
    points[index + 2] = { ...c, in: straight ? undefined : merged[2] };
    points.splice(index + 1, 1);
    original = samples;
  }
  return points.length < contour.points.length ? { ...contour, points } : contour;
}

export function simplifyRasterContour(contour: VectorContour): VectorContour {
  return simplifyContour(contour, { remaining: 512 });
}

export function simplifyRasterPaths(paths: RasterTrace["paths"]): RasterTrace["paths"] {
  const budget = { remaining: 512 };
  return paths.map((path) => {
    const contours = path.vectorPath.contours;
    if (path.name || !contours || contours.length !== 1) return path;
    const [original] = contours;
    if (!original) return path;
    const simplified = simplifyContour(original, budget);
    return simplified === original
      ? path
      : {
          ...path,
          vectorPath: {
            ...path.vectorPath,
            contours: [simplified],
            d: serializeContours([simplified]),
          },
        };
  });
}
