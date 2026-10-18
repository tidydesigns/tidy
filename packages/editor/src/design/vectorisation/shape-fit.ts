import {
  parsePathContours,
  type VectorContour,
  type VectorPoint,
} from "@tidy/design/vector-geometry";

/** Propose clean geometry in its own orientation. The caller still verifies the
 * final image; a fit is a candidate, not evidence of object identity. */
export function fitRasterShape(contour: VectorContour): { contour: VectorContour; name?: string } {
  const samples = sampleRasterContour(contour);
  const aligned = fitAxisAligned(contour, 0.8, samples);
  if (aligned.name) return aligned;
  if (samples.length < 3) return aligned;
  // Tiny contours stay editable, but cannot support a reliable primitive fit.
  // Avoid the orientation searches for small accents and raster fragments.
  if (
    Math.max(...samples.map((p) => p.x)) - Math.min(...samples.map((p) => p.x)) < 6 &&
    Math.max(...samples.map((p) => p.y)) - Math.min(...samples.map((p) => p.y)) < 6
  )
    return aligned;
  const center = {
    x: samples.reduce((sum, p) => sum + p.x, 0) / samples.length,
    y: samples.reduce((sum, p) => sum + p.y, 0) / samples.length,
  };
  const rotatePoint = (point: VectorPoint, angle: number): VectorPoint => {
    const c = Math.cos(angle),
      s = Math.sin(angle),
      x = point.x - center.x,
      y = point.y - center.y;
    return { x: center.x + x * c - y * s, y: center.y + x * s + y * c };
  };
  const rotate = (shape: VectorContour, angle: number): VectorContour => ({
    ...shape,
    points: shape.points.map((point) => ({
      ...point,
      ...rotatePoint(point, angle),
      in: point.in && rotatePoint(point.in, angle),
      out: point.out && rotatePoint(point.out, angle),
    })),
  });
  const boxArea = (angle: number) => {
    const c = Math.cos(angle),
      s = Math.sin(angle);
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const point of samples) {
      const x = point.x * c - point.y * s,
        y = point.x * s + point.y * c;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    return (right - left) * (bottom - top);
  };
  let bestAngle = 0,
    bestArea = boxArea(0);
  for (let degrees = 3; degrees < 90; degrees += 3) {
    const angle = (degrees * Math.PI) / 180,
      area = boxArea(angle);
    if (area < bestArea) {
      bestAngle = angle;
      bestArea = area;
    }
  }
  const coarse = bestAngle;
  for (let degrees = -3; degrees <= 3; degrees += 0.1) {
    const angle = coarse + (degrees * Math.PI) / 180,
      area = boxArea(angle);
    if (area < bestArea) {
      bestAngle = angle;
      bestArea = area;
    }
  }
  const ellipseResidual = (angle: number) => {
    const points = samples.map((point) => rotatePoint(point, angle));
    const left = Math.min(...points.map((p) => p.x)),
      right = Math.max(...points.map((p) => p.x));
    const top = Math.min(...points.map((p) => p.y)),
      bottom = Math.max(...points.map((p) => p.y));
    const rx = (right - left) / 2,
      ry = (bottom - top) / 2;
    if (Math.min(rx, ry) < 3) return Infinity;
    return points.reduce(
      (sum, p) =>
        sum +
        (Math.hypot((p.x - (left + right) / 2) / rx, (p.y - (top + bottom) / 2) / ry) - 1) ** 2,
      0,
    );
  };
  let ellipseAngle = 0,
    ellipseError = ellipseResidual(0);
  for (let degrees = 3; degrees < 90; degrees += 3) {
    const angle = (degrees * Math.PI) / 180,
      error = ellipseResidual(angle);
    if (error < ellipseError) {
      ellipseAngle = angle;
      ellipseError = error;
    }
  }
  const ellipseCoarse = ellipseAngle;
  for (let degrees = -3; degrees <= 3; degrees += 0.1) {
    const angle = ellipseCoarse + (degrees * Math.PI) / 180,
      error = ellipseResidual(angle);
    if (error < ellipseError) {
      ellipseAngle = angle;
      ellipseError = error;
    }
  }
  for (const angleCandidate of [ellipseAngle, bestAngle])
    if (Math.abs(angleCandidate) > 0.001) {
      const fitted = fitAxisAligned(rotate(contour, angleCandidate), 1.5);
      if (fitted.name) return { ...fitted, contour: rotate(fitted.contour, -angleCandidate) };
    }
  return fitPolygon(contour, samples);
}

/** Bounded closed-path simplification. Keep concavities; never use the convex
 * hull as a replacement for a general contour. Dense curves remain curves. */
function fitPolygon(
  contour: VectorContour,
  samples: VectorPoint[],
): { contour: VectorContour; name?: string } {
  if (samples.length > 4096) return { contour };
  const distance = (p: VectorPoint, a: VectorPoint, b: VectorPoint) => {
    const dx = b.x - a.x,
      dy = b.y - a.y,
      length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  };
  const reduce = (points: VectorPoint[], depth = 0): VectorPoint[] => {
    if (depth >= 32) return points;
    let maximum = 0.9,
      split = -1;
    for (let i = 1; i < points.length - 1; i++) {
      const error = distance(points[i], points[0], points.at(-1)!);
      if (error > maximum) {
        maximum = error;
        split = i;
      }
    }
    return split < 0
      ? [points[0], points.at(-1)!]
      : [
          ...reduce(points.slice(0, split + 1), depth + 1).slice(0, -1),
          ...reduce(points.slice(split), depth + 1),
        ];
  };
  let opposite = 1,
    longest = 0;
  for (let i = 1; i < samples.length; i++) {
    const value = Math.hypot(samples[i].x - samples[0].x, samples[i].y - samples[0].y);
    if (value > longest) {
      opposite = i;
      longest = value;
    }
  }
  const points = [
    ...reduce(samples.slice(0, opposite + 1)).slice(0, -1),
    ...reduce([...samples.slice(opposite), samples[0]]).slice(0, -1),
  ];
  for (let i = points.length - 1; i >= 0 && points.length > 3; i--) {
    if (
      distance(
        points[i],
        points[(i + points.length - 1) % points.length],
        points[(i + 1) % points.length],
      ) <= 0.9
    )
      points.splice(i, 1);
  }
  if (points.length < 3 || points.length > 12 || points.length >= contour.points.length)
    return { contour };
  // A polygon must be supported by long straight runs, not merely approximate a smooth loop.
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 4) return { contour };
  }
  return {
    name: points.length === 3 ? "Triangle" : "Polygon",
    contour: {
      ...contour,
      points: points.map((point, i) => ({ ...point, id: `${contour.id}-${i}` })),
    },
  };
}

/** Only replace a contour when the entire boundary agrees with a geometric primitive.
 * The tolerance is at most 1.2 working pixels. Holes are fitted independently.
 * This recognises geometry, not semantic subjects or the original SVG structure.
 */
function fitAxisAligned(
  contour: VectorContour,
  tolerance = 0.8,
  samples = sampleRasterContour(contour),
): {
  contour: VectorContour;
  name?: string;
} {
  if (!samples.length) return { contour };
  const x = Math.min(...samples.map((p) => p.x)),
    y = Math.min(...samples.map((p) => p.y));
  const width = Math.max(...samples.map((p) => p.x)) - x,
    height = Math.max(...samples.map((p) => p.y)) - y;
  if (Math.min(width, height) < 6) return { contour };
  const cx = x + width / 2,
    cy = y + height / 2,
    rx = width / 2,
    ry = height / 2;
  const replace = (d: string, name: string) => {
    const fitted = parsePathContours(d)[0];
    fitted.id = contour.id;
    fitted.points.forEach((p, i) => {
      p.id = `${contour.id}-${i}`;
    });
    return { contour: fitted, name };
  };
  const ellipseError = Math.max(
    ...samples.map(
      (p) => Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1) * Math.min(rx, ry),
    ),
  );
  if (ellipseError <= (Math.min(rx, ry) >= 12 ? Math.max(1.2, tolerance) : tolerance))
    return replace(
      `M ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy} Z`,
      "Ellipse",
    );
  // Fit a uniform corner radius using the rounded rectangle's signed distance.
  const error = (radius: number) =>
    Math.max(
      ...samples.map((p) => {
        const qx = Math.abs(p.x - cx) - rx + radius,
          qy = Math.abs(p.y - cy) - ry + radius;
        return Math.abs(
          Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius,
        );
      }),
    );
  let radius = 0,
    best = error(0);
  const estimate = Math.min(...samples.map((p) => p.x - x + (p.y - y))) / (2 - Math.SQRT2);
  for (
    let r = Math.max(0.25, Math.round((estimate - 1) * 4) / 4);
    r <= Math.min(rx, ry, estimate + 1);
    r += 0.25
  ) {
    const value = error(r);
    if (value < best) {
      radius = r;
      best = value;
    }
  }
  if (best > tolerance) return { contour };
  if (!radius) return replace(`M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`, "Rectangle");
  return replace(
    `M ${x + radius} ${y} H ${x + width - radius} A ${radius} ${radius} 0 0 1 ${x + width} ${y + radius} V ${y + height - radius} A ${radius} ${radius} 0 0 1 ${x + width - radius} ${y + height} H ${x + radius} A ${radius} ${radius} 0 0 1 ${x} ${y + height - radius} V ${y + radius} A ${radius} ${radius} 0 0 1 ${x + radius} ${y} Z`,
    "Rounded rectangle",
  );
}

export function sampleRasterContour(contour: VectorContour): VectorPoint[] {
  const samples: VectorPoint[] = [];
  const points = contour.points;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length],
      u = a.out ?? a,
      v = b.in ?? b;
    for (let j = 0; j < 8; j++) {
      const t = j / 8,
        s = 1 - t;
      samples.push({
        x: s ** 3 * a.x + 3 * s ** 2 * t * u.x + 3 * s * t ** 2 * v.x + t ** 3 * b.x,
        y: s ** 3 * a.y + 3 * s ** 2 * t * u.y + 3 * s * t ** 2 * v.y + t ** 3 * b.y,
      });
    }
  }
  return samples;
}
