import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { serializeContours, type VectorContour } from "@tidy/design/vector-geometry";
import {
  simplifyRasterContour,
  simplifyRasterPaths,
} from "../../../../../packages/editor/src/design/vectorisation/simplify";
import {
  rasterTraceRequestSchema,
  rasterTraceResponseSchema,
  traceLimits,
  type RasterTrace,
} from "./contract";

function subdividedCurve(): VectorContour {
  const count = 12;
  const position = (t: number) => ({ x: 8 + 32 * t, y: 24 - 48 * t * (1 - t) });
  return {
    id: "curve",
    closed: false,
    points: Array.from({ length: count + 1 }, (_, i) => {
      const t = i / count,
        point = position(t),
        dx = 32 / count / 3,
        dy = (-48 + 96 * t) / count / 3;
      return {
        ...point,
        id: `point-${i}`,
        in: i ? { x: point.x - dx, y: point.y - dy } : undefined,
        out: i < count ? { x: point.x + dx, y: point.y + dy } : undefined,
      };
    }),
  };
}
function path(contours: VectorContour[]): RasterTrace["paths"][number] {
  return {
    color: "#000000",
    opacity: 1,
    vectorPath: {
      contours,
      d: serializeContours(contours),
      viewBox: { x: 0, y: 0, width: 48, height: 48 },
      fillRule: "evenodd",
    },
  };
}
async function raster(contour: VectorContour) {
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><path d="${serializeContours([contour])}" fill="none" stroke="black" stroke-width="2"/></svg>`,
    ),
  )
    .ensureAlpha()
    .raw()
    .toBuffer();
}

test("merges a subdivided smooth curve without changing its endpoints or raster appearance", async () => {
  const original = subdividedCurve(),
    saved = structuredClone(original);
  const result = simplifyRasterContour(original);
  expect(result.points.length).toBeLessThan(original.points.length / 2);
  expect(result.points[0].x).toBe(original.points[0].x);
  expect(result.points[0].y).toBe(original.points[0].y);
  expect(result.points.at(-1)?.x).toBe(original.points.at(-1)?.x);
  expect(result.points.at(-1)?.y).toBe(original.points.at(-1)?.y);
  expect(original).toEqual(saved);
  const before = await raster(original),
    after = await raster(result);
  const difference =
    before.reduce((sum, value, i) => sum + Math.abs(value - after[i]), 0) / before.length;
  expect(difference).toBeLessThan(0.1);
  expect(simplifyRasterContour(original)).toEqual(result);
});

test("keeps the corners and closing edge of a curved closed contour", () => {
  const curve = subdividedCurve();
  const original = {
    ...curve,
    closed: true,
    points: [...curve.points, { id: "right", x: 40, y: 40 }, { id: "left", x: 8, y: 40 }],
  };
  const result = simplifyRasterContour(original);
  expect(result.closed).toBe(true);
  expect(result.points.length).toBeLessThan(original.points.length);
  expect(result.points.slice(-2)).toEqual(original.points.slice(-2));
  expect(result.points.find((point) => point.id === "point-12")?.out).toBeUndefined();
  expect(result.points[0].in).toBeUndefined();
});

test("leaves straight corners, tiny contours, fitted primitives and holes unchanged", () => {
  const corners: VectorContour = {
    id: "corners",
    closed: true,
    points: [
      [0, 0],
      [20, 0],
      [20, 10],
      [10, 10],
      [10, 20],
      [0, 20],
    ].map(([x, y], i) => ({ x, y, id: String(i) })),
  };
  expect(simplifyRasterContour(corners)).toBe(corners);
  const empty: VectorContour = { id: "empty", closed: false, points: [] };
  expect(simplifyRasterContour(empty)).toBe(empty);
  const curve = subdividedCurve();
  const hole = path([curve, corners]),
    primitive = { ...path([curve]), name: "Ellipse" };
  const result = simplifyRasterPaths([hole, primitive]);
  expect(result[0]).toBe(hole);
  expect(result[1]).toBe(primitive);
});

describe("raster worker request boundary", () => {
  test("accepts a transferable pixel buffer and the maximum supported dimensions", () => {
    for (const [width, height] of [
      [1, 1],
      [1024, 256],
    ]) {
      const request = {
        width,
        height,
        buffer: new ArrayBuffer(width * height * 4),
        colors: "auto",
        lossy: false,
      };
      const parsed = rasterTraceRequestSchema.parse(request);
      expect(parsed.buffer).toBe(request.buffer);
    }
  });
  test("rejects malformed requests before canvas allocation", () => {
    const valid = { width: 1, height: 1, buffer: new ArrayBuffer(4), colors: "auto" };
    const requests: unknown[] = [
      null,
      {},
      { ...valid, width: NaN },
      { ...valid, width: Infinity },
      { ...valid, width: 1.5 },
      { ...valid, height: 0 },
      { ...valid, width: traceLimits.edge + 1 },
      { ...valid, colors: 3 },
      { ...valid, lossy: "false" },
      { ...valid, buffer: new Uint8Array(4) },
      { ...valid, buffer: new ArrayBuffer(3) },
      { ...valid, width: 1024, height: 257, buffer: new ArrayBuffer(1024 * 257 * 4) },
    ];
    for (const request of requests)
      expect(rasterTraceRequestSchema.safeParse(request).success).toBe(false);
  });
});

test("a traced curved silhouette needs fewer editable points while retaining its appearance", async () => {
  const { traceRaster } = await import("./trace");
  const points = Array.from({ length: 360 }, (_, i) => {
    const angle = (i * Math.PI) / 180,
      radius = 80 + 12 * Math.cos(3 * angle);
    return `${128 + Math.cos(angle) * radius},${128 + Math.sin(angle) * radius}`;
  });
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><polygon points="${points.join(" ")}" fill="#087f68"/></svg>`;
  const data = new Uint8ClampedArray(
    await sharp(Buffer.from(source)).ensureAlpha().raw().toBuffer(),
  );
  const result = traceRaster({ width: 256, height: 256, data: data.slice() }, "auto");
  expect(result.paths).toHaveLength(1);
  expect(result.pointCount).toBeLessThanOrEqual(27);
  const rendered = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">${result.paths.map((path) => `<path d="${path.vectorPath.d}" fill="${path.color}" opacity="${path.opacity}"/>`).join("")}</svg>`,
    ),
  )
    .ensureAlpha()
    .raw()
    .toBuffer();
  const alphaError =
    data.reduce((sum, value, i) => sum + (i % 4 === 3 ? Math.abs(value - rendered[i]) : 0), 0) /
    (256 * 256);
  expect(alphaError).toBeLessThan(0.5);
});

test("merging collinear segments keeps a native straight line", () => {
  const contour: VectorContour = {
    id: "line",
    closed: false,
    points: Array.from({ length: 9 }, (_, i) => ({ id: `line-${i}`, x: i * 5, y: 5 })),
  };
  const result = simplifyRasterContour(contour);
  expect(result.points).toHaveLength(2);
  expect(result.points.every((point) => !point.in && !point.out)).toBe(true);
  expect(serializeContours([result])).toBe("M 0 5 L 40 5");
});

test("worker replies validate geometry and discriminate success from failure", async () => {
  const { traceRaster } = await import("./trace");
  const trace = traceRaster({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) }, 2);
  const success = { kind: "success" as const, trace, verified: true };
  expect(rasterTraceResponseSchema.parse(success)).toEqual(success);
  expect(
    rasterTraceResponseSchema.parse({ kind: "error", error: "Cannot trace image." }).kind,
  ).toBe("error");
  const invalid: unknown[] = [
    null,
    {},
    { trace, verified: true },
    { ...success, verified: "true" },
    { ...success, error: "Ambiguous reply" },
    { kind: "error" },
    { ...success, trace: { ...trace, pointCount: trace.pointCount + 1 } },
    { ...success, trace: { ...trace, width: Infinity } },
    { ...success, trace: { ...trace, paths: [{ ...trace.paths[0], opacity: NaN }] } },
    {
      ...success,
      trace: {
        ...trace,
        paths: [
          { ...trace.paths[0], vectorPath: { ...trace.paths[0].vectorPath, d: "<script/>" } },
        ],
      },
    },
    { ...success, trace: { ...trace, fallback: { ...trace, pointCount: 0 } } },
  ];
  for (const reply of invalid)
    expect(rasterTraceResponseSchema.safeParse(reply).success).toBe(false);
});
