import { expect, test } from "bun:test";
import type { DesignNode } from "./document";
import { visibleCanvasRoots } from "./canvas-culling";
import { fitCanvasView, revealCanvasBounds } from "./canvas-view";

const frame: DesignNode = {
  id: "frame",
  parentId: null,
  name: "Imported artboard",
  type: "artboard",
  box: { x: 2931, y: 0, width: 1375, height: 3443 },
  style: { overflow: "hidden" },
  layout: "absolute",
  visible: true,
  locked: false,
};

test("revealing pasted content preserves an already-visible view", () => {
  const view = { x: 0, y: 0, zoom: 1 };
  expect(
    revealCanvasBounds(
      view,
      { width: 800, height: 600 },
      { x: 100, y: 100, width: 200, height: 100 },
    ),
  ).toBe(view);
});

test("revealing pasted content pans only as far as needed and fits oversized content", () => {
  const size = { width: 800, height: 600 };
  expect(
    revealCanvasBounds({ x: 0, y: 0, zoom: 1 }, size, { x: 750, y: 100, width: 100, height: 50 }),
  ).toEqual({ x: -90, y: 0, zoom: 1 });
  const bounds = { x: 3000, y: 5000, width: 2000, height: 1000 };
  const view = revealCanvasBounds({ x: 0, y: 0, zoom: 1 }, size, bounds);
  expect(view.zoom).toBeGreaterThan(0);
  expect(view.zoom).toBeLessThan(1);
  expect(bounds.x * view.zoom + view.x).toBeGreaterThanOrEqual(40);
  expect((bounds.x + bounds.width) * view.zoom + view.x).toBeLessThanOrEqual(760);
});

test("fitting undersized viewports never inverts or hides the imported artboard", () => {
  for (const size of [
    { width: 1375, height: 80 },
    { width: 80, height: 800 },
    { width: 120, height: 120 },
    { width: 0, height: 0 },
  ]) {
    const view = fitCanvasView([frame], size.width, size.height);
    expect(view.zoom).toBeGreaterThan(0);
    expect([view.x, view.y, view.zoom].every(Number.isFinite)).toBe(true);
    expect(visibleCanvasRoots([frame], view, size, [])).toEqual([frame.id]);
  }
});

test("a distant imported artboard fits inside the canvas with padding", () => {
  const view = fitCanvasView([frame], 1375, 800);
  expect(frame.box.x * view.zoom + view.x).toBeGreaterThanOrEqual(60);
  expect(frame.box.y * view.zoom + view.y).toBeCloseTo(60);
  expect(frame.box.height * view.zoom).toBeCloseTo(680);
});
