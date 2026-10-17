import type { VectorContour } from "@tidy/design/vector-geometry";

/** Fit outer coverage edges at subpixel precision. Thresholding both 50%-covered
 * sides of a thin stroke would otherwise turn a 3px stroke into a 4px outline.
 * Only accept a nearby, converged alpha crossing; opaque colour boundaries and
 * translucent overlaps without such a crossing retain their traced geometry.
 */
export function refineRasterCoverage(
  contour: VectorContour,
  image: { width: number; height: number; data: Uint8ClampedArray },
  opacity: number,
): VectorContour {
  const { width, height, data } = image;
  const sample = (x: number, y: number) => {
    x -= 0.5;
    y -= 0.5;
    const left = Math.floor(x),
      top = Math.floor(y),
      tx = x - left,
      ty = y - top;
    const at = (xx: number, yy: number) =>
      xx < 0 || yy < 0 || xx >= width || yy >= height
        ? 0
        : data[(yy * width + xx) * 4 + 3] / opacity;
    return (
      at(left, top) * (1 - tx) * (1 - ty) +
      at(left + 1, top) * tx * (1 - ty) +
      at(left, top + 1) * (1 - tx) * ty +
      at(left + 1, top + 1) * tx * ty
    );
  };
  return {
    ...contour,
    points: contour.points.map((point) => {
      let x = point.x,
        y = point.y;
      for (let i = 0; i < 4; i++) {
        const value = sample(x, y),
          gx = sample(x + 0.5, y) - sample(x - 0.5, y),
          gy = sample(x, y + 0.5) - sample(x, y - 0.5),
          length = gx * gx + gy * gy;
        if (length < 0.04) break;
        x -= ((value - 0.5) * gx) / length;
        y -= ((value - 0.5) * gy) / length;
        if (Math.hypot(x - point.x, y - point.y) > 0.8) return point;
      }
      if (Math.abs(sample(x, y) - 0.5) > 0.02) return point;
      const dx = x - point.x,
        dy = y - point.y;
      return {
        ...point,
        x,
        y,
        in: point.in && { x: point.in.x + dx, y: point.in.y + dy },
        out: point.out && { x: point.out.x + dx, y: point.out.y + dy },
      };
    }),
  };
}
