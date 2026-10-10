import { expect, test } from "bun:test";
import { buildDrawnNode, type DesignNode } from "./document";
import { fitImageBounds, proportionalImageSize } from "./image-sizing";
import { rotatePoint } from "./resize-box";

const node = (style: DesignNode["style"] = {}): DesignNode => ({
  ...buildDrawnNode("image", "container", null, { x: 100, y: 200, width: 400, height: 400 }),
  type: "image",
  style,
});
test("fitting contain bounds preserves visible size and focal point", () => {
  expect(fitImageBounds(node(), 800, 400)).toEqual({ x: 100, y: 300, width: 400, height: 200 });
  expect(fitImageBounds(node({ objectPositionY: 0 }), 800, 400)).toEqual({
    x: 100,
    y: 200,
    width: 400,
    height: 200,
  });
  expect(fitImageBounds(node({ objectPositionX: 100 }), 400, 800)).toEqual({
    x: 300,
    y: 200,
    width: 200,
    height: 400,
  });
});
test("rotated and flipped fitting preserves the world-space painted center", () => {
  for (const rotation of [0, 30, 90, -125])
    for (const flipY of [false, true]) {
      const image = node({ objectPositionY: 20, rotation, flipY });
      const fitted = fitImageBounds(image, 800, 400);
      const offset = rotatePoint({ x: 0, y: -60 * (flipY ? -1 : 1) }, rotation);
      expect(fitted.x + fitted.width / 2).toBeCloseTo(300 + offset.x);
      expect(fitted.y + fitted.height / 2).toBeCloseTo(400 + offset.y);
    }
});
test("crop aspect and borders/padding are preserved; unsupported transforms are rejected", () => {
  const cropped = node({
    imageCrop: { x: 0.1, y: 0.1, width: 0.25, height: 0.5, sourceWidth: 800, sourceHeight: 400 },
  });
  expect(fitImageBounds(cropped, 800, 400)).toEqual(cropped.box);
  const padded = { ...node({ borderWidth: 2 }), padding: 8 };
  expect(fitImageBounds(padded, 800, 400)).toEqual({ x: 100, y: 295, width: 400, height: 210 });
  expect(() => fitImageBounds(node({ objectFit: "cover" }), 800, 400)).toThrow();
  expect(() => fitImageBounds(node({ objectScale: 2 }), 800, 400)).toThrow();
  expect(() => fitImageBounds(node(), 0, 400)).toThrow();
});
test("numeric size limits clamp a common scale, without distorting the image", () => {
  const box = { x: 0, y: 0, width: 200, height: 100 };
  expect(proportionalImageSize(box, "width", 600)).toEqual({ width: 600, height: 300 });
  expect(proportionalImageSize(box, "height", 5000)).toEqual({ width: 5000, height: 2500 });
  expect(proportionalImageSize(box, "width", 1)).toEqual({ width: 2, height: 1 });
});
