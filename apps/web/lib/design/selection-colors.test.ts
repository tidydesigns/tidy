import { test, expect } from "bun:test";
import { buildDrawnNode, type DesignNode } from "./document";
import { selectionColors, replaceSelectionColor } from "./selection-colors";

test("selection palette includes rendered fills, stops, text, borders, and shadows without duplicates", () => {
  const a: DesignNode = {
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

test("recolouring detaches only matching tokens and preserves other gradient stops and image paints", () => {
  const node: DesignNode = {
    ...buildDrawnNode("colours", "container", null, { x: 0, y: 0, width: 100, height: 100 }),
    style: {
      paints: [
        {
          id: "image",
          type: "image",
          fit: "cover",
          positionX: 50,
          positionY: 50,
          opacity: 0.5,
          visible: true,
        },
        {
          id: "gradient",
          type: "linear",
          angle: 90,
          opacity: 0.6,
          visible: true,
          stops: [
            { id: "brand", position: 0, color: "#111111", token: "brand" },
            { id: "other", position: 1, color: "#222222", token: "other" },
          ],
        },
        { id: "hidden", type: "solid", color: "#123456", opacity: 1, visible: false },
      ],
      color: "#000000",
      colorToken: "brand",
      strokePaints: [
        {
          id: "stroke",
          type: "solid",
          color: "#000000",
          token: "brand",
          opacity: 0.7,
          visible: true,
        },
      ],
      borderWidth: 2,
    },
  };
  const result = replaceSelectionColor({
    node,
    tokens: { brand: "#123456", other: "#abcdef" },
    colour: "#123456",
    next: "#445566",
  });
  expect(result.style.color).toBe("#445566");
  expect(result.style.colorToken).toBeUndefined();
  expect(result.style.paints?.[0]).toEqual(node.style.paints?.[0]);
  expect(result.style.paints?.[2]).toEqual(node.style.paints?.[2]);
  const gradient = result.style.paints?.[1];
  expect(gradient?.type).toBe("linear");
  if (gradient?.type !== "linear") throw new Error("Expected the gradient to be preserved");
  expect(gradient.opacity).toBe(0.6);
  expect(gradient.stops[0]).toEqual({
    id: "brand",
    position: 0,
    color: "#445566",
    token: undefined,
  });
  expect(gradient.stops[1]).toEqual({ id: "other", position: 1, color: "#222222", token: "other" });
  expect(result.style.strokePaints?.[0]).toMatchObject({
    id: "stroke",
    color: "#445566",
    opacity: 0.7,
  });
  expect(result.style.borderWidth).toBe(2);
  expect(node.style.colorToken).toBe("brand");
});

test("hidden paints are excluded from selection colours", () => {
  const node: DesignNode = {
    ...buildDrawnNode("hidden", "container", null, { x: 0, y: 0, width: 10, height: 10 }),
    style: {
      paints: [{ id: "hidden", type: "solid", color: "#123456", opacity: 1, visible: false }],
    },
  };
  expect(selectionColors([node], {})).not.toContain("#123456");
});
