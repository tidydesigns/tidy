import { expect, test } from "bun:test";
import { fitPreview, wheelPreview, zoomPreview } from "./preview-navigation";

test("fits offset artwork into an independently sized preview", () => {
  const camera = fitPreview(
    { x: -200, y: 300, width: 600, height: 300 },
    { width: 300, height: 240 },
  );
  expect(camera).toEqual({ zoom: 0.5, x: 100, y: -105 });
});

test("zoom preserves the design point under the cursor, including at limits", () => {
  const camera = { x: -75, y: 32, zoom: 0.5 };
  for (const factor of [0.00001, 0.5, 2, 1e8]) {
    const next = zoomPreview(camera, 120, 80, factor);
    expect((120 - next.x) / next.zoom).toBeCloseTo((120 - camera.x) / camera.zoom);
    expect((80 - next.y) / next.zoom).toBeCloseTo((80 - camera.y) / camera.zoom);
    expect(next.zoom).toBeGreaterThanOrEqual(0.01);
    expect(next.zoom).toBeLessThanOrEqual(16);
  }
});

test("scroll pans in both axes while pinch and modifier wheels zoom", () => {
  const camera = { x: 50, y: 30, zoom: 1 };
  const wheel = { deltaX: 12, deltaY: 20, deltaMode: 0, ctrlKey: false, metaKey: false };
  expect(wheelPreview(camera, wheel, { x: 20, y: 20 }, 200)).toEqual({ x: 38, y: 10, zoom: 1 });
  expect(wheelPreview(camera, { ...wheel, deltaMode: 1 }, { x: 20, y: 20 }, 200).y).toBe(-290);
  expect(wheelPreview(camera, { ...wheel, deltaMode: 2 }, { x: 20, y: 20 }, 200).y).toBe(-3970);
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    expect(
      wheelPreview(camera, { ...wheel, ...modifier }, { x: 20, y: 20 }, 200).zoom,
    ).toBeLessThan(1);
  }
});
