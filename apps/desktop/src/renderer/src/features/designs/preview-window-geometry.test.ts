import { expect, test } from "bun:test";
import { constrainGeometry, resizeEdges, resizeGeometry } from "./preview-window-geometry";

const area = { width: 1000, height: 700 };
const geometry = { x: 100, y: 80, width: 300, height: 200 };

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
