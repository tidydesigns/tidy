import { expect, test } from "bun:test";
import { gestureZoomFactor, wheelZoomFactor } from "./canvas-zoom";

test("ordinary scrolling never changes zoom; pinch gestures do", () => {
  expect(wheelZoomFactor(-40, false)).toBe(1);
  expect(wheelZoomFactor(40, false)).toBe(1);
  const pinch = wheelZoomFactor(-40, true);
  expect(pinch).toBeGreaterThan(1.15);
  expect(wheelZoomFactor(40, true)).toBeLessThan(1);
  expect(gestureZoomFactor(1.1, 1)).toBeGreaterThan(1.25);
  expect(gestureZoomFactor(1, 1.1)).toBeCloseTo(1 / gestureZoomFactor(1.1, 1));
});
