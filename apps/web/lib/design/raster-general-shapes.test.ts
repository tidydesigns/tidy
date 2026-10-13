import { expect, test } from "bun:test";
import sharp from "sharp";
import { traceRaster } from "./raster-trace";
import { fitRasterLinearGradient } from "./raster-gradient";
import { generalRasterFixtures, rasterShapeSvg } from "../../scripts/raster-shape-fixtures";

async function pixels(body: string, jpeg = false) {
  let pipeline = sharp(Buffer.from(rasterShapeSvg(body)));
  if (jpeg) pipeline = sharp(await pipeline.flatten({ background: "#fff" }).jpeg().toBuffer());
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}
for (const fixture of generalRasterFixtures)
  test(`${fixture.name}: automatic palette and editable geometry`, async () => {
    const source = await pixels(fixture.body),
      trace = traceRaster(source, "auto");
    expect(trace.paths).toHaveLength(fixture.expectedShapes);
    if (fixture.id === "rotated-shapes")
      expect(trace.paths.map((p) => p.name).sort()).toEqual(
        ["Ellipse", "Rectangle", "Rounded rectangle"].sort(),
      );
    if (fixture.id === "linear-gradient") {
      expect(trace.paths[0].fill?.type).toBe("linear");
      expect(trace.paths[0].vectorPath.contours![0].points).toHaveLength(4);
    }
    if (fixture.id === "many-colours")
      expect(new Set(trace.paths.map((p) => p.color)).size).toBe(20);
    if (fixture.id === "thin-cutout") expect(trace.paths[0].vectorPath.contours).toHaveLength(3);
  });

test("JPEG cleanup retains the small saturated accent and close intentional shades", async () => {
  const source = await pixels(
    generalRasterFixtures.find((f) => f.id === "close-colours")!.body,
    true,
  );
  const trace = traceRaster(source, "auto", { lossy: true });
  expect(trace.paths.length).toBeLessThanOrEqual(6);
  expect(
    trace.paths.some((path) => {
      const red = parseInt(path.color.slice(1, 3), 16),
        green = parseInt(path.color.slice(3, 5), 16),
        blue = parseInt(path.color.slice(5, 7), 16);
      return red > green * 1.5 && red > blue * 1.5;
    }),
  ).toBe(true);
});

test("gradient reconstruction declines multicolour objects and nonlinear shading", async () => {
  expect(fitRasterLinearGradient(await pixels(generalRasterFixtures[0].body))).toBeUndefined();
  expect(
    fitRasterLinearGradient(
      await pixels(
        '<defs><radialGradient id="g"><stop stop-color="#fff"/><stop offset="1" stop-color="#347dcc"/></radialGradient></defs><rect width="624" height="380" fill="url(#g)"/>',
      ),
    ),
  ).toBeUndefined();
});
