import { expect, test } from "bun:test";
import sharp from "sharp";
import { traceRaster } from "./trace";
import {
  gradientRasterFixtures,
  rasterShapeSvg,
  rasterShapeFixtures,
  generalRasterFixtures,
} from "./fixtures";
import { measureRasterTrace, selectVerifiedRasterTrace, traceCandidateIsFaithful } from "./quality";
import type { RasterTrace } from "./contract";

function svg(trace: RasterTrace) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${trace.width}" height="${trace.height}">${trace.paths
    .map((path, i) => {
      const fill = path.fill;
      const stops = fill?.stops
        .map((s) => `<stop offset="${s.position}" stop-color="${s.color}"/>`)
        .join("");
      const definition = !fill
        ? ""
        : fill.type === "linear"
          ? `<linearGradient id="g${i}" gradientUnits="userSpaceOnUse" x1="${fill.start!.x * trace.width}" y1="${fill.start!.y * trace.height}" x2="${fill.end!.x * trace.width}" y2="${fill.end!.y * trace.height}">${stops}</linearGradient>`
          : `<radialGradient id="g${i}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${fill.centerX * trace.width} ${fill.centerY * trace.height}) scale(${fill.radiusX * trace.width} ${fill.radiusY * trace.height})">${stops}</radialGradient>`;
      return `${definition}<path d="${path.vectorPath.d}" fill="${fill ? `url(#g${i})` : path.color}" opacity="${path.opacity}" fill-rule="evenodd"/>`;
    })
    .join("")}</svg>`;
}

for (const fixture of gradientRasterFixtures) {
  test(`${fixture.id}: verified editable gradients improve on palette bands`, async () => {
    const { data, info } = await sharp(Buffer.from(rasterShapeSvg(fixture.body)))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const original = { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
    const candidate = traceRaster({ ...original, data: original.data.slice() }, "auto");
    expect(candidate.paths.length).toBeLessThanOrEqual(fixture.maxShapes);
    expect(candidate.paths.some((p) => p.fill)).toBe(true);
    if (fixture.id === "radial-gradient") expect(candidate.paths[0].fill?.type).toBe("radial");
    if (fixture.id === "gradient-cutout")
      expect(candidate.paths[0].vectorPath.contours).toHaveLength(3);
    const render = async (trace: RasterTrace) =>
      new Uint8ClampedArray(
        await sharp(Buffer.from(svg(trace)))
          .ensureAlpha()
          .raw()
          .toBuffer(),
      );
    const quality = measureRasterTrace(original, await render(candidate));
    const baseline = measureRasterTrace(original, await render(candidate.fallback!));
    expect(quality.meanError).toBeLessThan(2);
    expect(quality.alphaError).toBeLessThan(0.6);
    expect(quality.meanError).toBeLessThan(baseline.meanError);
    expect(traceCandidateIsFaithful(quality, baseline)).toBe(true);
    expect(
      selectVerifiedRasterTrace(candidate, quality, baseline).paths.length,
    ).toBeLessThanOrEqual(fixture.maxShapes);
    if (fixture.id === "gradient-highlights") {
      const rendered = await render(candidate);
      // Sum a narrow strip so subpixel antialiasing may move coverage between
      // rows, while a missing intentional highlight still fails the check.
      for (const [x, y] of [
        [130, 105],
        [170, 185],
        [230, 265],
      ]) {
        let sourceSignal = 0,
          tracedSignal = 0;
        for (let row = y - 1; row <= y + 1; row++) {
          const offset = (row * original.width + x) * 4;
          const background = data[(row * original.width + 10) * 4];
          sourceSignal += Math.max(0, data[offset] - background);
          tracedSignal += Math.max(0, rendered[offset] - background);
        }
        expect(tracedSignal).toBeGreaterThan(sourceSignal * 0.7);
        expect(tracedSignal).toBeLessThan(sourceSignal * 1.3);
      }
    }
  });
}

for (const fixture of [
  ...rasterShapeFixtures,
  ...generalRasterFixtures.filter((f) => f.id !== "linear-gradient"),
]) {
  test(`${fixture.id}: gradient recovery leaves simple artwork unchanged`, async () => {
    const { data, info } = await sharp(Buffer.from(rasterShapeSvg(fixture.body)))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const image = { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
    const current = traceRaster({ ...image, data: image.data.slice() }, "auto");
    const previous = traceRaster({ ...image, data: image.data.slice() }, "auto", {
      gradientRegions: false,
    });
    expect(current).toEqual(previous);
  });
}

for (const [name, body] of [
  [
    "two-dimensional shading",
    '<defs><linearGradient id="a"><stop stop-color="#f06470"/><stop offset="1" stop-color="#367abf"/></linearGradient><radialGradient id="b"><stop stop-color="#f4d679"/><stop offset="1" stop-color="#516584"/></radialGradient></defs><rect width="624" height="380" fill="url(#a)"/><rect width="624" height="380" fill="url(#b)" opacity=".5"/>',
  ],
  [
    "changing interior opacity",
    '<defs><linearGradient id="a"><stop stop-color="#e85c69" stop-opacity=".2"/><stop offset="1" stop-color="#367abf" stop-opacity=".9"/></linearGradient></defs><rect x="40" y="40" width="544" height="300" fill="url(#a)"/>',
  ],
]) {
  test(`${name}: decline an unsupported gradient model without changing the trace`, async () => {
    const { data, info } = await sharp(Buffer.from(rasterShapeSvg(body)))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const image = { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
    const trace = traceRaster({ ...image, data: image.data.slice() }, "auto");
    const baseline = traceRaster({ ...image, data: image.data.slice() }, "auto", {
      gradientRegions: false,
    });
    expect(trace).toEqual(baseline);
  });
}
