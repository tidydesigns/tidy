import { expect, test } from "bun:test";
import { measureRasterTrace, traceCandidateIsFaithful } from "./quality";

const image = (width: number, height: number, rgba: number[]) => ({
  width,
  height,
  data: new Uint8ClampedArray(Array.from({ length: width * height }, () => rgba).flat()),
});

test("verification checks alpha and both backgrounds, including white-on-transparent errors", () => {
  const original = image(16, 16, [255, 255, 255, 255]);
  const hidden = image(16, 16, [255, 255, 255, 0]);
  const exact = measureRasterTrace(original, original.data);
  expect(exact.meanError).toBe(0);
  const lost = measureRasterTrace(original, hidden.data);
  expect(lost.meanError).toBe(255);
  expect(lost.alphaError).toBe(255);
  expect(traceCandidateIsFaithful(lost, exact)).toBe(false);
});

test("small lost features are exposed by local tile error, despite a low global average", () => {
  const original = image(256, 256, [255, 255, 255, 255]),
    missing = original.data.slice();
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) original.data.set([255, 0, 0, 255], (y * 256 + x) * 4);
  const exact = measureRasterTrace(original, original.data),
    lost = measureRasterTrace(original, missing);
  expect(lost.meanError).toBeLessThan(0.5);
  expect(lost.worstTileError).toBeGreaterThan(40);
  expect(traceCandidateIsFaithful(lost, exact)).toBe(false);
});

test("faithful simpler candidates pass; bad dimensions cannot enter verification", () => {
  const original = image(16, 16, [255, 0, 0, 255]);
  const exact = measureRasterTrace(original, original.data);
  expect(traceCandidateIsFaithful(exact, exact)).toBe(true);
  expect(() => measureRasterTrace(original, new Uint8ClampedArray(4))).toThrow("dimensions differ");
});

test("a rejected simplification returns the original contour geometry and never persists alternatives", async () => {
  const { selectVerifiedRasterTrace } = await import("./quality");
  const fallback = { width: 16, height: 16, paths: [], pointCount: 0 };
  const proposed = { ...fallback, pointCount: 4, fallback };
  const exact = {
    meanError: 0,
    alphaError: 0,
    changedFraction: 0,
    worstTileError: 0,
    detailLoss: 0,
  };
  expect(selectVerifiedRasterTrace(proposed, { ...exact, worstTileError: 30 }, exact)).toBe(
    fallback,
  );
  expect(selectVerifiedRasterTrace(proposed, exact, exact).fallback).toBeUndefined();
  expect(() =>
    selectVerifiedRasterTrace({ ...fallback }, { ...exact, worstTileError: 90 }),
  ).toThrow("loses too much detail");
});

test("automatic verification rejects missing thin strokes even when pixel and tile errors are small", async () => {
  const { selectVerifiedRasterTrace } = await import("./quality");
  const original = image(512, 256, [255, 255, 255, 255]),
    missing = original.data.slice();
  for (let x = 20; x < 100; x++) original.data.set([100, 100, 100, 255], (30 * 512 + x) * 4);
  const lost = measureRasterTrace(original, missing);
  expect(lost.meanError).toBeLessThan(1);
  expect(lost.worstTileError).toBeLessThan(20);
  expect(lost.detailLoss).toBe(1);
  expect(() =>
    selectVerifiedRasterTrace(
      { width: 512, height: 256, paths: [], pointCount: 0 },
      lost,
      undefined,
      { automatic: true },
    ),
  ).toThrow("loses too much detail");
});
