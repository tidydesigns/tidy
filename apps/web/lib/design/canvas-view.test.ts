import { expect, test } from "bun:test";
import type { DesignNode } from "./document";
import { visibleCanvasRoots } from "./canvas-culling";
import { fitCanvasView } from "./canvas-view";

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
