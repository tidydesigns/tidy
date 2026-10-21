import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { traceRaster } from "./trace";
import { traceLimits, traceSize } from "./contract";
import { serializeContours } from "@tidy/design/vector-geometry";

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
  test.each([3, 5, 8])(
    "dense %ipx details share bounded layers without losing pixels",
    async (size) => {
      const source = pixels(256, 256, (x, y) =>
        x % 14 < size && y % 14 < size ? [255, 0, 0, 255] : [0, 0, 0, 0],
      );
      const result = traceRaster(structuredClone(source), 8);
      expect(result.paths.length).toBeLessThanOrEqual(5);
      expect(result.paths.flatMap((p) => p.vectorPath.contours!).length).toBe(361);
      for (const path of result.paths) {
        expect(path.vectorPath.contours!.length).toBeLessThanOrEqual(100);
        expect(path.vectorPath.contours!.flatMap((c) => c.points).length).toBeLessThanOrEqual(1000);
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">${result.paths
        .map((p) => `<path d="${p.vectorPath.d}" fill="${p.color}" fill-rule="evenodd"/>`)
        .join("")}</svg>`;
      const rendered = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
      expect(new Uint8ClampedArray(rendered)).toEqual(source.data);
    },
  );
  test("keeps larger disconnected objects subject to the editable layer limit", () => {
    const image = pixels(256, 256, (x, y) =>
      x % 14 < 10 && y % 14 < 10 ? [255, 0, 0, 255] : [0, 0, 0, 0],
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

test("retains tiny intentional lossless accents alongside large shapes", () => {
  const result = traceRaster(
    pixels(128, 128, (x, y) =>
      x >= 4 && x < 100 && y >= 4 && y < 100
        ? [255, 0, 0, 255]
        : x === 110 && y >= 32 && y < 34
          ? [255, 0, 0, 255]
          : x >= 110 && x < 112 && y >= 40 && y < 42
            ? [0, 0, 255, 255]
            : [0, 0, 0, 0],
    ),
    "auto",
  );
  expect(result.paths.map((path) => path.color).sort()).toEqual(["#0000ff", "#ff0000", "#ff0000"]);
  expect(result.fallback?.paths.length).toBe(3);
});

for (const size of [1, 2, 3, 4, 5, 6]) {
  for (const transparent of [false, true]) {
    test(`preserves a ${size}px solid accent on ${transparent ? "transparent" : "opaque"} artwork`, () => {
      const image = pixels(64, 64, (x, y) =>
        x >= 10 && x < 10 + size && y >= 10 && y < 10 + size
          ? [224, 32, 64, 255]
          : x >= 32 && y >= 32
            ? [8, 127, 104, 255]
            : [255, 255, 255, transparent ? 0 : 255],
      );
      const trace = traceRaster(image, "auto");
      const accent = trace.paths.find((path) => path.color === "#e02040");
      expect(accent).toBeDefined();
      expect(accent!.vectorPath.contours![0].points.map(({ x, y }) => [x, y])).toEqual([
        [10, 10],
        [10 + size, 10],
        [10 + size, 10 + size],
        [10, 10 + size],
      ]);
      expect(trace.paths).toHaveLength(transparent ? 2 : 3);
    });
  }
}

test("compacts tiny accents across same-paint objects while keeping larger objects editable", () => {
  const image = pixels(96, 32, (x, y) => {
    const cell = Math.floor(x / 12),
      size = cell % 2 ? 6 : 1;
    return x % 12 >= 2 && x % 12 < 2 + size && y >= 10 && y < 10 + size
      ? [224, 32, 64, 255]
      : [0, 0, 0, 0];
  });
  const trace = traceRaster(image, "auto");
  expect(trace.paths).toHaveLength(5);
  expect(trace.paths.flatMap((path) => path.vectorPath.contours!)).toHaveLength(8);
  expect(trace.fallback!.paths).toHaveLength(5);
});

test("keeps a two-pixel accent whose coverage colours vary slightly", () => {
  const shades = [
    [64, 156, 138, 255],
    [66, 157, 140, 255],
    [66, 157, 140, 255],
    [67, 158, 140, 255],
  ];
  const image = pixels(64, 64, (x, y) =>
    x >= 39 && x <= 40 && y >= 39 && y <= 40
      ? shades[(y - 39) * 2 + x - 39]
      : x >= 10 && x < 12 && y >= 10 && y < 12
        ? [224, 32, 64, 255]
        : [255, 255, 255, 255],
  );
  const trace = traceRaster(image, "auto");
  expect(trace.paths).toHaveLength(3);
  expect(
    trace.paths.some((path) => {
      const red = parseInt(path.color.slice(1, 3), 16);
      const green = parseInt(path.color.slice(3, 5), 16);
      return green > red * 1.5;
    }),
  ).toBe(true);
});

for (const transparent of [false, true]) {
  for (const radius of [2, 3, 4]) {
    test(`fits a ${radius * 2}px antialiased circle on ${transparent ? "transparent" : "opaque"} artwork without extra layers`, async () => {
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">${transparent ? "" : '<rect width="48" height="48" fill="#fff"/>'}<circle cx="24.25" cy="24.5" r="${radius}" fill="#087f68"/></svg>`;
      const data = new Uint8ClampedArray(
        await sharp(Buffer.from(source)).ensureAlpha().raw().toBuffer(),
      );
      const trace = traceRaster({ width: 48, height: 48, data }, "auto");
      expect(trace.paths).toHaveLength(transparent ? 1 : 2);
      const circle = trace.paths.find((path) => path.color === "#087f68")!;
      expect(circle.name).toBe("Ellipse");
      const points = circle.vectorPath.contours![0].points;
      expect(points).toHaveLength(4);
      expect(Math.min(...points.map((p) => p.x))).toBeCloseTo(24.25 - radius, 1);
      expect(Math.max(...points.map((p) => p.y))).toBeCloseTo(24.5 + radius, 1);
    });
  }
}

test("small ellipse recovery keeps holes and nearby independent shapes", async () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><path fill="#087f68" fill-rule="evenodd" d="M8 8h12v12H8z M12 12v4h4v-4z"/><circle cx="30" cy="30" r="3" fill="#087f68"/><rect x="33" y="29" width="3" height="3" fill="#e02040"/></svg>';
  const data = new Uint8ClampedArray(
    await sharp(Buffer.from(source)).ensureAlpha().raw().toBuffer(),
  );
  const trace = traceRaster({ width: 48, height: 48, data }, "auto");
  expect(trace.paths.some((path) => path.vectorPath.contours?.length === 2)).toBe(true);
  expect(trace.paths.some((path) => path.color === "#e02040")).toBe(true);
});
