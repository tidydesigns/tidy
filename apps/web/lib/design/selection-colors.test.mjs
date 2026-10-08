import { test, expect } from "bun:test";
import { buildDrawnNode } from "./document";
import { addRecentColor, selectionColors } from "./selection-colors";

test("selection palette includes rendered fills, stops, text, borders, and shadows without duplicates", () => {
  const a = {
    ...buildDrawnNode("a", "container", null, { x: 0, y: 0, width: 100, height: 100 }),
    style: {
      paints: [
        { id: "solid", type: "solid", color: "#000000", token: "brand", opacity: 1, visible: true },
        {
          id: "gradient",
          type: "linear",
          angle: 90,
          opacity: 1,
          visible: true,
          stops: [
            { id: "a", position: 0, color: "#AABBCC" },
            { id: "b", position: 1, color: "#123456", token: "brand" },
          ],
        },
      ],
      borderColor: "#AABBCC",
      shadows: [
        { x: 0, y: 0, blur: 1, spread: 0, color: "#44556688", inset: false, visible: true },
      ],
    },
  };
  const b = {
    ...buildDrawnNode("b", "text", null, { x: 0, y: 0, width: 100, height: 20 }),
    style: { color: "#778899", outlineColor: "#44556688" },
  };
  expect(selectionColors([a, b], { brand: "#FEDCBA" })).toEqual([
    "#fedcba",
    "#aabbcc",
    "#44556688",
    "#778899",
  ]);
});

test("recent colors normalize, deduplicate, bound, and reject invalid values", () => {
  expect(addRecentColor(["#abcdef", "#123456"], "#ABCDEF")).toEqual(["#abcdef", "#123456"]);
  expect(addRecentColor(["#abcdef"], "bad")).toEqual(["#abcdef"]);
  expect(
    Array.from({ length: 14 }, (_, index) => index.toString(16).padStart(6, "0")).reduce(
      (colors, value) => addRecentColor(colors, `#${value}`),
      [],
    ).length,
  ).toBe(12);
});
