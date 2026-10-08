import { expect, test } from "bun:test";
import { resizeBox, resizeHandles, rotatePoint } from "./resize-box";
import { snapLayerResize } from "./resize-snapping";

const original = { x: 20, y: 30, width: 100, height: 50 };
const identity = { a: 1, b: 0, c: 0, d: 1 };
const center = { x: 70, y: 55 };

test("single-layer edges snap to other edges and centers at a screen-pixel tolerance", () => {
  const target = { ...original, width: 179 };
  const candidates = [{ x: 200, y: 300, width: 40, height: 80 }];
  expect(snapLayerResize(original, target, "e", center, identity, candidates, 6)).toEqual({
    ...target,
    width: 180,
  });
  expect(
    snapLayerResize(original, { ...target, width: 198 }, "e", center, identity, candidates, 6)
      .width,
  ).toBe(200);
  expect(
    snapLayerResize(original, { ...target, width: 170 }, "e", center, identity, candidates, 6)
      .width,
  ).toBe(170);
  expect(snapLayerResize(original, target, "e", center, identity, [], 6)).toEqual(target);
  const zoom = 8;
  expect(
    snapLayerResize(
      original,
      target,
      "e",
      { x: center.x * zoom, y: center.y * zoom },
      { a: zoom, b: 0, c: 0, d: zoom },
      [{ x: 200 * zoom, y: 300 * zoom, width: 320, height: 640 }],
      6,
    ),
  ).toEqual(target);
});

test("all handles preserve rotated/flipped anchors, centered sizing and exact aspect under transformed parents", () => {
  for (const handle of resizeHandles)
    for (const angle of [0, 35, 90, -145])
      for (const flipX of [false, true])
        for (const flipY of [false, true])
          for (const centered of [false, true])
            for (const aspect of [false, true]) {
              const options = { rotation: angle, flipX, flipY, centered, aspect };
              const h = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
              const v = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
              const parent = (point: { x: number; y: number }) =>
                rotatePoint({ x: point.x * 1.5, y: point.y * 1.5 }, 27);
              const local = (x: number, y: number) =>
                rotatePoint({ x: x * (flipX ? -1 : 1), y: y * (flipY ? -1 : 1) }, angle);
              const mx = parent(local(1, 0)),
                my = parent(local(0, 1));
              const matrix = { a: mx.x, b: mx.y, c: my.x, d: my.y };
              const initialCenter = parent(center);
              // Independently project the desired visual handle through the parent transform.
              const expected = resizeBox(original, handle, local(h * 20, v * 10), options);
              const expectedOffset = local((h * expected.width) / 2, (v * expected.height) / 2);
              const point = parent({
                x: expected.x + expected.width / 2 + expectedOffset.x,
                y: expected.y + expected.height / 2 + expectedOffset.y,
              });
              const near = resizeBox(original, handle, local(h * 19.5, v * 9.75), options);
              const result = snapLayerResize(
                original,
                near,
                handle,
                initialCenter,
                matrix,
                [{ x: point.x, y: point.y, width: 80, height: 120 }],
                6,
                options,
              );
              for (const key of ["x", "y", "width", "height"] as const)
                expect(result[key]).toBeCloseTo(expected[key], 6);
              if (aspect)
                expect(result.width / result.height).toBeCloseTo(
                  original.width / original.height,
                  10,
                );
            }
});

test("snapping cannot cross schema size limits or pull a constrained handle far off its path", () => {
  const tiny = { x: 20, y: 30, width: 1, height: 50 };
  expect(
    snapLayerResize(
      tiny,
      tiny,
      "e",
      { x: 20.5, y: 55 },
      identity,
      [{ x: 20.5, y: 300, width: 100, height: 100 }],
      6,
    ),
  ).toEqual(tiny);
  const huge = { ...original, width: 5000 };
  expect(
    snapLayerResize(
      huge,
      huge,
      "e",
      { x: 2520, y: 55 },
      identity,
      [{ x: 5021, y: 300, width: 100, height: 100 }],
      6,
    ),
  ).toEqual(huge);
  const angle = 89.99,
    axis = rotatePoint({ x: 1, y: 0 }, angle),
    other = rotatePoint({ x: 0, y: 1 }, angle);
  const matrix = { a: axis.x, b: axis.y, c: other.x, d: other.y };
  const moving = { x: center.x + axis.x * 50, y: center.y + axis.y * 50 };
  expect(
    snapLayerResize(
      original,
      original,
      "e",
      center,
      matrix,
      [{ x: moving.x + 1, y: moving.y + 100, width: 100, height: 100 }],
      6,
      { rotation: angle },
    ),
  ).toEqual(original);
});
