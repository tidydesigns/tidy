import { expect, test } from "bun:test";
import sharp from "sharp";
import { traceRaster } from "./raster-trace";
import { rasterShapeFixtures, rasterShapeSvg } from "../../scripts/raster-shape-fixtures";

for (const fixture of rasterShapeFixtures) {
  test(`${fixture.name}: coherent regions, faithful paint and geometry`, async () => {
    const { data, info } = await sharp(Buffer.from(rasterShapeSvg(fixture.body)))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const trace = traceRaster(
      { width: info.width, height: info.height, data: new Uint8ClampedArray(data) },
      8,
    );
    expect(trace.paths.length).toBeLessThanOrEqual(fixture.maxShapes);
    expect(trace.paths.every((path) => path.opacity === 1)).toBe(true);
    if (fixture.id === "app-icon") {
      expect(trace.paths.map((path) => path.color).sort()).toEqual([
        "#087f68",
        "#f2b642",
        "#fff1d0",
      ]);
      // Moving the leaf must not expose a leaf-shaped hole in the background.
      expect(trace.paths[0].name).toBe("Rounded rectangle");
      expect(trace.paths[0].vectorPath.contours).toHaveLength(1);
      const accent = trace.paths.find((path) => path.color === "#f2b642")!;
      expect(accent.name).toBe("Ellipse");
      expect(accent.vectorPath.contours![0].points).toHaveLength(4);
      expect(trace.paths.find((path) => path.color === "#fff1d0")!.name).toBeUndefined();
    }
    if (fixture.id === "illustration") {
      const mountain = trace.paths.find((path) => path.color === "#337d74")!;
      expect(mountain.name).toBe("Triangle");
      expect(mountain.vectorPath.contours).toHaveLength(1);
      expect(mountain.vectorPath.contours![0].points).toHaveLength(3);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="624" height="380">${trace.paths.map((path) => `<path d="${path.vectorPath.d}" fill="${path.color}" fill-rule="evenodd"/>`).join("")}</svg>`;
    const rendered = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
    let difference = 0;
    for (let i = 0; i < data.length; i += 4)
      for (let k = 0; k < 3; k++) {
        const original = (data[i + k] * data[i + 3]) / 255 + 255 - data[i + 3];
        const vector = (rendered[i + k] * rendered[i + 3]) / 255 + 255 - rendered[i + 3];
        difference += Math.abs(original - vector);
      }
    expect(difference / (info.width * info.height * 3)).toBeLessThan(2);
  });
}

test("separate objects sharing a colour remain separately editable", async () => {
  const body = Array.from(
    { length: 6 },
    (_, i) => `<circle cx="${50 + i * 95}" cy="190" r="24" fill="#087f68"/>`,
  ).join("");
  const { data, info } = await sharp(Buffer.from(rasterShapeSvg(body)))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const trace = traceRaster(
    { width: info.width, height: info.height, data: new Uint8ClampedArray(data) },
    8,
  );
  expect(trace.paths).toHaveLength(6);
  expect(
    trace.paths.every((path) => path.name === "Ellipse" && path.vectorPath.contours?.length === 1),
  ).toBe(true);
});

test("triangle recovery preserves intentional transparent cutouts", async () => {
  const body =
    '<path fill="#087f68" fill-rule="evenodd" d="M40 330L310 40L580 330ZM230 250L310 140L390 250Z"/>';
  const { data, info } = await sharp(Buffer.from(rasterShapeSvg(body)))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const trace = traceRaster(
    { width: info.width, height: info.height, data: new Uint8ClampedArray(data) },
    8,
  );
  expect(trace.paths).toHaveLength(1);
  expect(trace.paths[0].vectorPath.contours).toHaveLength(2);
});

test("triangle recovery does not bridge separate objects across an opaque background", async () => {
  const body =
    '<rect width="624" height="380" fill="#fff"/><path fill="#087f68" d="M40 330L140 40L240 330ZM380 330L480 40L580 330Z"/>';
  const { data, info } = await sharp(Buffer.from(rasterShapeSvg(body)))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const trace = traceRaster(
    { width: info.width, height: info.height, data: new Uint8ClampedArray(data) },
    8,
  );
  expect(trace.paths.filter((path) => path.color === "#087f68")).toHaveLength(2);
});
