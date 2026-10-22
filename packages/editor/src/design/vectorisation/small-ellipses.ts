import { serializeContours } from "@tidy/design/vector-geometry";
import type { RasterPixels, RasterTrace } from "./contract";

type Path = RasterTrace["paths"][number];
type EllipseModel = [x: number, y: number, radiusX: number, radiusY: number];
type Bounds = { left: number; top: number; right: number; bottom: number };

function bounds(path: Path): Bounds {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const contour of path.vectorPath.contours ?? [])
    for (const point of contour.points)
      for (const p of [point, point.in, point.out]) {
        if (!p) continue;
        left = Math.min(left, p.x);
        top = Math.min(top, p.y);
        right = Math.max(right, p.x);
        bottom = Math.max(bottom, p.y);
      }
  return { left, top, right, bottom };
}

function fit(image: RasterPixels, path: Path, box: Bounds) {
  const left = Math.max(0, Math.floor(box.left) - 3),
    top = Math.max(0, Math.floor(box.top) - 3),
    right = Math.min(image.width, Math.ceil(box.right) + 3),
    bottom = Math.min(image.height, Math.ceil(box.bottom) + 3);
  const pixel = (x: number, y: number) => {
    const i = (y * image.width + x) * 4,
      alpha = image.data[i + 3];
    return [
      (image.data[i] * alpha) / 255,
      (image.data[i + 1] * alpha) / 255,
      (image.data[i + 2] * alpha) / 255,
      alpha,
    ];
  };
  const background = pixel(left, top);
  if (background[3] !== 0 && background[3] !== 255) return;
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      if (x !== left && x !== right - 1 && y !== top && y !== bottom - 1) continue;
      if (pixel(x, y).some((v, k) => Math.abs(v - background[k]) > 2)) return;
    }
  const foreground = [1, 3, 5].map((i) => parseInt(path.color.slice(i, i + 2), 16));
  foreground.push(255);
  const delta = foreground.map((v, k) => v - background[k]);
  const contrast = delta.reduce((sum, v) => sum + v * v, 0);
  if (contrast < 4096) return;
  const samples: { x: number; y: number; coverage: number }[] = [];
  let mass = 0,
    sumX = 0,
    sumY = 0;
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const rgba = pixel(x, y);
      const coverage = Math.max(
        0,
        Math.min(1, rgba.reduce((sum, v, k) => sum + (v - background[k]) * delta[k], 0) / contrast),
      );
      if (rgba.some((v, k) => Math.abs(v - background[k] - coverage * delta[k]) > 4)) return;
      samples.push({ x, y, coverage });
      mass += coverage;
      sumX += (x + 0.5) * coverage;
      sumY += (y + 0.5) * coverage;
    }
  if (mass < 5) return;
  const cx = sumX / mass,
    cy = sumY / mass;
  let xx = 0,
    yy = 0;
  for (const s of samples) {
    xx += (s.x + 0.5 - cx) ** 2 * s.coverage;
    yy += (s.y + 0.5 - cy) ** 2 * s.coverage;
  }
  const ratio = Math.sqrt(Math.max(0.1, xx / mass - 1 / 12) / Math.max(0.1, yy / mass - 1 / 12));
  let model: EllipseModel = [
    cx,
    cy,
    Math.sqrt((mass * ratio) / Math.PI),
    Math.sqrt(mass / ratio / Math.PI),
  ];
  const coverageAt = (x: number, y: number, m: EllipseModel) => {
    let sum = 0;
    for (let i = 0; i < 8; i++) {
      const dy = (y + (i + 0.5) / 8 - m[1]) / m[3];
      if (Math.abs(dy) >= 1) continue;
      const extent = m[2] * Math.sqrt(1 - dy * dy);
      sum += Math.max(0, Math.min(x + 1, m[0] + extent) - Math.max(x, m[0] - extent));
    }
    return sum / 8;
  };
  const error = (m: EllipseModel) => {
    if (
      Math.min(m[2], m[3]) < 1 ||
      m[0] - m[2] <= left ||
      m[0] + m[2] >= right ||
      m[1] - m[3] <= top ||
      m[1] + m[3] >= bottom
    )
      return Infinity;
    return samples.reduce((sum, s) => sum + (coverageAt(s.x, s.y, m) - s.coverage) ** 2, 0);
  };
  let best = error(model);
  for (const step of [0.25, 0.125, 0.0625, 0.03125])
    for (let axis = 0; axis < 4; axis++) {
      const origin = model;
      for (const direction of [-1, 1]) {
        const candidate: EllipseModel = [...origin];
        candidate[axis] += step * direction;
        const value = error(candidate);
        if (value < best) {
          best = value;
          model = candidate;
        }
      }
    }
  if (
    best / mass > 0.0015 ||
    samples.some((s) => Math.abs(coverageAt(s.x, s.y, model) - s.coverage) > 0.16)
  )
    return;
  if (
    path.name === "Ellipse" &&
    best >=
      error([
        (box.left + box.right) / 2,
        (box.top + box.bottom) / 2,
        (box.right - box.left) / 2,
        (box.bottom - box.top) / 2,
      ]) *
        0.8
  )
    return;
  const [x, y, rx, ry] = model;
  const id = path.vectorPath.contours![0].id;
  const kappa = (4 * (Math.SQRT2 - 1)) / 3;
  const contours = [
    {
      id,
      closed: true,
      points: [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ].map(([dx, dy], i) => ({
        id: `${id}-${i}`,
        x: x + dx * rx,
        y: y + dy * ry,
        in: { x: x + dx * rx + dy * rx * kappa, y: y + dy * ry - dx * ry * kappa },
        out: { x: x + dx * rx - dy * rx * kappa, y: y + dy * ry + dx * ry * kappa },
      })),
    },
  ];
  return {
    path: {
      ...path,
      name: "Ellipse",
      vectorPath: { ...path.vectorPath, contours, d: serializeContours(contours) },
    },
    box: { left, top, right, bottom },
    background,
    delta,
    contrast,
  };
}

export function recoverSmallRasterEllipses(paths: Path[], image: RasterPixels): Path[] {
  const boxes = paths.map(bounds),
    removed = new Set<number>(),
    replacements = new Map<number, Path>();
  let attempts = 0;
  for (let i = 0; i < paths.length && attempts < 32; i++) {
    const path = paths[i],
      box = boxes[i];
    if (
      removed.has(i) ||
      path.fill ||
      path.opacity !== 1 ||
      path.vectorPath.contours?.length !== 1 ||
      (path.name && path.name !== "Ellipse" && path.name !== "Rectangle") ||
      box.right - box.left > 32 ||
      box.bottom - box.top > 32 ||
      box.right - box.left < 2 ||
      box.bottom - box.top < 2
    )
      continue;
    attempts++;
    const fitted = fit(image, path, box);
    if (!fitted) continue;
    replacements.set(i, fitted.path);
    for (let j = 0; j < paths.length; j++) {
      if (i === j || removed.has(j) || paths[j].fill || replacements.has(j)) continue;
      const b = boxes[j];
      if (
        b.left < fitted.box.left + 1 ||
        b.top < fitted.box.top + 1 ||
        b.right > fitted.box.right - 1 ||
        b.bottom > fitted.box.bottom - 1
      )
        continue;
      const rgba = [1, 3, 5].map(
        (k) => parseInt(paths[j].color.slice(k, k + 2), 16) * paths[j].opacity,
      );
      rgba.push(255 * paths[j].opacity);
      const t =
        rgba.reduce((sum, v, k) => sum + (v - fitted.background[k]) * fitted.delta[k], 0) /
        fitted.contrast;
      if (
        t > 0 &&
        t <= 1.01 &&
        rgba.every((v, k) => Math.abs(v - fitted.background[k] - t * fitted.delta[k]) < 4)
      )
        removed.add(j);
    }
  }
  return paths.flatMap((path, i) => (removed.has(i) ? [] : [replacements.get(i) ?? path]));
}
