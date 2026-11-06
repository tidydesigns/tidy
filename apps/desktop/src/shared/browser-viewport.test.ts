import { expect, test } from "bun:test";
import { browserDeviceScaleFactor, browserFrameSize } from "./browser-viewport";

test("Retina capture keeps CSS coordinates and doubles image resolution within its budget", () => {
  expect(browserDeviceScaleFactor(1000, 700, 2)).toBe(2);
  expect(browserFrameSize({ width: 1000, height: 700, deviceScaleFactor: 2 })).toEqual({
    width: 2000,
    height: 1400,
  });
  expect(browserFrameSize({ width: 1000, height: 700 })).toEqual({ width: 1000, height: 700 });
  for (const [width, height] of [
    [2560, 1600],
    [1920, 1080],
    [390, 844],
  ] as const) {
    const scale = browserDeviceScaleFactor(width, height, 3);
    const frame = browserFrameSize({ width: width, height: height, deviceScaleFactor: scale });
    expect(scale).toBeGreaterThanOrEqual(1);
    expect(scale).toBeLessThanOrEqual(2);
    expect(frame.width * frame.height).toBeLessThanOrEqual(4_198_500);
    expect(frame.width).toBeLessThanOrEqual(3840);
    expect(frame.height).toBeLessThanOrEqual(2160);
  }
});
