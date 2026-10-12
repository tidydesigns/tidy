import { describe, expect, test } from "bun:test";
import { traceRaster } from "./raster-trace";
import { traceLimits, traceSize } from "./raster-trace-contract";
import { serializeContours } from "@bella/design/vector-geometry";

function pixels(
  width = 32,
  height = 32,
  paint: (x: number, y: number) => number[] = () => [255, 0, 0, 255],
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  return { width, height, data };
}
describe("raster tracing", () => {
  test("multicolour artwork becomes native editable paths deterministically", () => {
    const image = pixels(32, 32, (x) => (x < 16 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const result = traceRaster(structuredClone(image), 8);
    expect(result.paths.map((path) => path.color).sort()).toEqual(["#0000ff", "#ff0000"]);
    expect(traceRaster(structuredClone(image), 8)).toEqual(result);
    for (const path of result.paths) {
      expect(path.vectorPath.contours?.length).toBeGreaterThan(0);
      expect(serializeContours(path.vectorPath.contours!)).toBe(path.vectorPath.d);
    }
  });
  test("transparent holes remain holes, with no black background from hidden RGB", () => {
    const image = pixels(32, 32, (x, y) =>
      x > 3 && x < 28 && y > 3 && y < 28 && !(x > 11 && x < 20 && y > 11 && y < 20)
        ? [255, 0, 0, 255]
        : [33, 99, 77, 0],
    );
    const result = traceRaster(image, 8);
    expect(result.paths.length).toBe(1);
    expect(result.paths[0].vectorPath.fillRule).toBe("evenodd");
    expect(result.paths[0].vectorPath.contours?.length).toBe(2);
    expect(result.paths[0].opacity).toBe(1);
  });
  test("retains partial alpha and opaque white", () => {
    const result = traceRaster(
      pixels(32, 32, (x) => (x < 16 ? [255, 255, 255, 255] : [255, 0, 0, 128])),
      8,
    );
    expect(result.paths.find((path) => path.color === "#ffffff")?.opacity).toBe(1);
    expect(result.paths.find((path) => path.color === "#ff0000")?.opacity).toBeCloseTo(128 / 255);
  });
  test("curves have editable Bezier handles", () => {
    const result = traceRaster(
      pixels(64, 64, (x, y) => (Math.hypot(x - 32, y - 32) < 24 ? [0, 0, 0, 255] : [0, 0, 0, 0])),
      2,
    );
    expect(
      result.paths
        .flatMap((p) => p.vectorPath.contours!.flatMap((c) => c.points))
        .some((p) => p.in || p.out),
    ).toBe(true);
  });
  test("rejects empty, oversized and malformed inputs", () => {
    expect(() =>
      traceRaster(
        pixels(32, 32, () => [0, 0, 0, 0]),
        8,
      ),
    ).toThrow("visible pixels");
    expect(() =>
      traceRaster({ width: 1025, height: 1, data: new Uint8ClampedArray(4100) }, 8),
    ).toThrow("pixel limit");
    expect(() => traceRaster({ width: 2, height: 2, data: new Uint8ClampedArray(3) }, 8)).toThrow(
      "pixel limit",
    );
  });
  test("rejects excessive disconnected geometry rather than silently losing shapes", () => {
    const image = pixels(128, 128, (x, y) =>
      x % 6 < 3 && y % 6 < 3 ? [255, 0, 0, 255] : [0, 0, 0, 0],
    );
    expect(() => traceRaster(image, 8)).toThrow("too many shapes");
  });
  test("bounds working pixels while preserving aspect ratio", () => {
    for (const [width, height] of [
      [5000, 5000],
      [5000, 50],
      [500, 1000],
      [1, 5000],
    ]) {
      const size = traceSize(width, height);
      expect(size.width * size.height).toBeLessThanOrEqual(traceLimits.pixels);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(traceLimits.edge);
    }
    expect(traceSize(32, 32)).toEqual({ width: 32, height: 32 });
    expect(() => traceSize(Infinity, 32)).toThrow();
  });
});
