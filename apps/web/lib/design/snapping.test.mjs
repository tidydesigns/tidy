import { test, expect } from "bun:test";
import { boundingBox, equalSpacingCues, snapResize, snapTranslation } from "./snapping";
test("selection bounds include every selected layer", () => {
  expect(
    boundingBox([
      { x: -10, y: 5, width: 20, height: 30 },
      { x: 30, y: -15, width: 10, height: 15 },
    ]),
  ).toEqual({ x: -10, y: -15, width: 50, height: 50 });
  expect(boundingBox([])).toBeNull();
});
test("snapping selects the closest edge or center and leaves distant movement alone", () => {
  const source = { x: 0, y: 0, width: 10, height: 20 };
  const target = { x: 40, y: 100, width: 10, height: 20 };
  const result = snapTranslation(source, { x: 39, y: 35 }, [target], 3);
  expect(result.x).toBe(40);
  expect(result.y).toBe(35);
  expect(result.guides).toEqual([{ axis: "x", position: 40, start: 35, end: 120 }]);
  expect(snapTranslation(source, { x: 15, y: 35 }, [target], 3)).toEqual({
    x: 15,
    y: 35,
    guides: [],
  });
});
test("screen tolerance remains consistent across zoom levels", () => {
  const source = { x: 0, y: 0, width: 20, height: 20 },
    target = { x: 100, y: 100, width: 20, height: 20 };
  expect(snapTranslation(source, { x: 95, y: 35 }, [target], 6 / 1).x).toBe(100);
  expect(snapTranslation(source, { x: 95, y: 35 }, [target], 6 / 2).x).toBe(95);
});
test("resize snapping moves only the dragged edge and uses a zoom-scaled tolerance", () => {
  const box = { x: 10, y: 20, width: 89, height: 79 };
  const candidates = [{ x: 100, y: 100, width: 20, height: 20 }];
  expect(snapResize(box, "se", candidates, 6)).toEqual({ x: 10, y: 20, width: 90, height: 80 });
  expect(snapResize(box, "se", candidates, 6 / 8)).toEqual(box);
  expect(snapResize({ x: 101, y: 20, width: 20, height: 20 }, "w", candidates, 6)).toEqual({
    x: 100,
    y: 20,
    width: 21,
    height: 20,
  });
});
test("equal spacing cues pair adjacent gaps along the overlapping axis", () => {
  const selected = { x: 30, y: 0, width: 20, height: 20 };
  const left = { x: 0, y: 5, width: 20, height: 10 },
    right = { x: 60, y: 5, width: 20, height: 10 };
  expect(equalSpacingCues(selected, { x: 0, y: 0 }, [left, right], 1)).toEqual([
    { axis: "x", start: 20, end: 30, cross: 10, gap: 10 },
    { axis: "x", start: 50, end: 60, cross: 10, gap: 10 },
  ]);
  expect(equalSpacingCues(selected, { x: 3, y: 0 }, [left, right], 1)).toEqual([]);
  expect(equalSpacingCues(selected, { x: 0, y: 0 }, [{ ...left, y: 25 }, right], 1)).toEqual([]);
});
