import { expect, test } from "bun:test";
import {
  constrainGeometry,
  fitPreview,
  gestureMoved,
  resizeEdges,
  resizeGeometry,
  wheelPreview,
  zoomPreview,
} from "./preview-navigation";

const area = { width: 1000, height: 700 };
const geometry = { x: 100, y: 80, width: 300, height: 200 };

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

test("edge resizing changes only its axis and corners resize independently", () => {
  expect(resizeGeometry(geometry, "e", 80, 100, area)).toEqual({ ...geometry, width: 380 });
  expect(resizeGeometry(geometry, "s", 80, 100, area)).toEqual({ ...geometry, height: 300 });
  expect(resizeGeometry(geometry, "nw", -50, -20, area)).toEqual({
    x: 50,
    y: 60,
    width: 350,
    height: 220,
  });
  expect(resizeGeometry(geometry, "sw", -50, 100, area)).toEqual({
    x: 50,
    y: 80,
    width: 350,
    height: 300,
  });
  for (const edge of resizeEdges) {
    const next = resizeGeometry(geometry, edge, -10000, -10000, area);
    expect(next.width).toBeGreaterThanOrEqual(220);
    expect(next.height).toBeGreaterThanOrEqual(140);
    expect(next.x).toBeGreaterThanOrEqual(0);
    expect(next.y).toBeGreaterThanOrEqual(0);
    expect(next.x + next.width).toBeLessThanOrEqual(area.width);
    expect(next.y + next.height).toBeLessThanOrEqual(area.height);
  }
});

test("workspace shrink keeps the header reachable and ordinary layout preserves placement", () => {
  expect(constrainGeometry(geometry, area)).toEqual(geometry);
  expect(constrainGeometry(geometry, { width: 180, height: 100 })).toEqual({
    x: 0,
    y: 0,
    width: 180,
    height: 100,
  });
  expect(constrainGeometry({ ...geometry, x: 900, y: 660 }, area)).toEqual({
    ...geometry,
    x: 700,
    y: 500,
  });
});

test("click tolerance distinguishes jitter from a completed drag", () => {
  expect(gestureMoved(2, 2)).toBe(false);
  expect(gestureMoved(3, 4)).toBe(true);
  expect(gestureMoved(-6, 0)).toBe(true);
});
