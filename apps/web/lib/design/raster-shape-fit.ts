import {
  parsePathContours,
  type VectorContour,
  type VectorPoint,
} from "@bella/design/vector-geometry";

/** Only replace a contour when the entire boundary agrees with a geometric primitive.
 * The tolerance is at most 1.2 working pixels. Holes are fitted independently.
 * This recognises geometry, not semantic subjects or the original SVG structure.
 */
export function fitRasterShape(contour: VectorContour): {
  contour: VectorContour;
  name?: string;
} {
  const samples = sampleRasterContour(contour);
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
  if (ellipseError <= (Math.min(rx, ry) >= 12 ? 1.2 : 0.8))
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
  if (best > 0.8) return { contour };
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
