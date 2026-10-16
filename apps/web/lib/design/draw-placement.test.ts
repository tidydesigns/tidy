import { expect, test } from "bun:test";
import { absoluteNodePosition, canvasWorldPoint, containingDrawParent } from "./draw-placement";

test("drawing upward beyond an imported frame creates a visible root layer", () => {
  const nodes = [
    { id: "frame", parentId: null, box: { x: 120, y: 120, width: 800, height: 600 } },
    { id: "group", parentId: "frame", box: { x: 40, y: 40, width: 300, height: 200 } },
  ];
  expect(absoluteNodePosition(nodes, "group")).toEqual({ x: 160, y: 160 });
  expect(containingDrawParent(nodes, "group", { x: 170, y: 130, width: 50, height: 40 })).toBe(
    "frame",
  );
  expect(containingDrawParent(nodes, "group", { x: 170, y: 70, width: 50, height: 90 })).toBeNull();
  expect(containingDrawParent(nodes, "group", { x: 170, y: 170, width: 50, height: 40 })).toBe(
    "group",
  );
});

test("open canvas above the origin keeps negative world coordinates", () => {
  expect(canvasWorldPoint({ x: 250, y: 100 }, { x: 0, y: 0 }, { x: 250, y: 300, zoom: 1 })).toEqual(
    { x: 0, y: -200 },
  );
});

test("pixel snapping can be disabled for precise placement at zoom", () => {
  const point = { x: 101, y: 51 };
  const view = { x: 0, y: 0, zoom: 2 };
  expect(canvasWorldPoint(point, { x: 0, y: 0 }, view)).toEqual({ x: 51, y: 26 });
  expect(canvasWorldPoint(point, { x: 0, y: 0 }, view, false)).toEqual({ x: 50.5, y: 25.5 });
});
