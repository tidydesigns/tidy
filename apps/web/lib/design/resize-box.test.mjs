import { test, expect } from "bun:test";
import { resizeBox, rotatePoint, rotationFromPointer } from "./resize-box";

const box = { x: 20, y: 30, width: 100, height: 50 };
const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const corner = (b, x, y, angle) => {
  const point = rotatePoint({ x: b.width * x, y: b.height * y }, angle);
  const c = center(b);
  return { x: c.x + point.x, y: c.y + point.y };
};
test("every handle changes its intended edges while preserving the opposite anchor", () => {
  expect(resizeBox(box, "nw", { x: -10, y: -20 })).toEqual({
    x: 10,
    y: 10,
    width: 110,
    height: 70,
  });
  expect(resizeBox(box, "ne", { x: 10, y: -20 })).toEqual({ x: 20, y: 10, width: 110, height: 70 });
  expect(resizeBox(box, "sw", { x: -10, y: 20 })).toEqual({ x: 10, y: 30, width: 110, height: 70 });
  expect(resizeBox(box, "se", { x: 10, y: 20 })).toEqual({ x: 20, y: 30, width: 110, height: 70 });
  expect(resizeBox(box, "n", { x: 500, y: -20 })).toEqual({ x: 20, y: 10, width: 100, height: 70 });
  expect(resizeBox(box, "s", { x: 500, y: 20 })).toEqual({ ...box, height: 70 });
  expect(resizeBox(box, "e", { x: 10, y: 500 })).toEqual({ ...box, width: 110 });
  expect(resizeBox(box, "w", { x: -10, y: 500 })).toEqual({ ...box, x: 10, width: 110 });
});
test("rotated resize preserves the opposite visual corner", () => {
  for (const angle of [-135, -30, 45, 90, 180]) {
    const next = resizeBox(box, "nw", rotatePoint({ x: -20, y: -10 }, angle), { rotation: angle });
    const beforeAnchor = corner(box, 0.5, 0.5, angle);
    const afterAnchor = corner(next, 0.5, 0.5, angle);
    expect(afterAnchor.x).toBeCloseTo(beforeAnchor.x, 8);
    expect(afterAnchor.y).toBeCloseTo(beforeAnchor.y, 8);
  }
});
test("centered resizing and locked proportions preserve center and exact ratio at size bounds", () => {
  const next = resizeBox(box, "e", { x: 10, y: 0 }, { centered: true, aspect: true });
  expect(next.width).toBe(120);
  expect(next.height).toBe(60);
  expect(center(next)).toEqual(center(box));
  const min = resizeBox(box, "se", { x: -500, y: -500 }, { aspect: true });
  expect(min.width / min.height).toBe(2);
  expect(min.height).toBe(1);
  const max = resizeBox(box, "se", { x: 10000, y: 10000 }, { aspect: true });
  expect(max.width).toBe(5000);
  expect(max.height).toBe(2500);
});
test("rotation crosses the angle seam smoothly and supports fifteen-degree snapping", () => {
  expect(rotationFromPointer(30, 170, -170)).toBe(50);
  expect(rotationFromPointer(0, 0, 22, true)).toBe(15);
  expect(rotationFromPointer(170, 0, 30)).toBe(-160);
});
test("flipped resize anchors the opposite visual edge", () => {
  const next = resizeBox(box, "e", { x: -20, y: 0 }, { flipX: true });
  expect(next).toEqual({ ...box, x: 0, width: 120 });
  expect(next.x + next.width).toBe(box.x + box.width);
});
