import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDrawnNode, type DesignPaint } from "@tidy/design/document";
import { NodeFills } from "@tidy/design-renderer/node-fills";
import { nodeStyle } from "@tidy/design-renderer/node-style";

const solid: Extract<DesignPaint, { type: "solid" }> = {
  id: "solid",
  type: "solid",
  color: "#ff0000",
  token: "brand",
  opacity: 1,
  visible: true,
};
const linear: Extract<DesignPaint, { type: "linear" }> = {
  id: "linear",
  type: "linear",
  angle: 90,
  opacity: 1,
  visible: true,
  stops: [
    { id: "start", position: 0, color: "#ff0000", token: "brand" },
    { id: "end", position: 1, color: "#0000ff" },
  ],
};
const radial: Extract<DesignPaint, { type: "radial" }> = {
  id: "radial",
  type: "radial",
  opacity: 1,
  visible: true,
  centerX: 0.5,
  centerY: 0.5,
  radiusX: 0.5,
  radiusY: 0.5,
  stops: linear.stops,
};

const cases: {
  name: string;
  paints: DesignPaint[];
  background?: string;
  fillStack: boolean;
}[] = [
  { name: "empty fill stacks", paints: [], fillStack: false },
  { name: "opaque token fills", paints: [solid], background: "#00ff00", fillStack: false },
  {
    name: "explicit normal blending",
    paints: [{ ...solid, blendMode: "normal" }],
    background: "#00ff00",
    fillStack: false,
  },
  { name: "hidden fills", paints: [{ ...solid, visible: false }], fillStack: true },
  { name: "transparent fills", paints: [{ ...solid, opacity: 0 }], fillStack: true },
  { name: "translucent fills", paints: [{ ...solid, opacity: 0.5 }], fillStack: true },
  { name: "multiple fills", paints: [solid, linear], fillStack: true },
  {
    name: "unpositioned linear gradients",
    paints: [linear],
    background: "linear-gradient(90deg, #00ff00 0%, #0000ff 100%)",
    fillStack: false,
  },
  {
    name: "positioned linear gradients",
    paints: [{ ...linear, start: { x: 0.25, y: 0.5 }, end: { x: 0.75, y: 0.5 } }],
    fillStack: true,
  },
  {
    name: "zero-rotation radial gradients",
    paints: [{ ...radial, rotation: 0 }],
    background: "radial-gradient(ellipse 50% 50% at 50% 50%, #00ff00 0%, #0000ff 100%)",
    fillStack: false,
  },
  {
    name: "image fills",
    paints: [
      {
        id: "image",
        type: "image",
        opacity: 1,
        visible: true,
        fit: "cover",
        positionX: 50,
        positionY: 50,
      },
    ],
    fillStack: true,
  },
];

for (const { name, paints, background, fillStack } of cases) {
  test(`${name} render through the node background or fill stack consistently`, () => {
    const node = {
      ...buildDrawnNode("node", "container", null, { x: 0, y: 0, width: 100, height: 100 }),
      style: { paints },
    };
    const tokens = { brand: "#00ff00" };
    expect(nodeStyle(node, "absolute", tokens).background).toBe(background);
    const html = renderToStaticMarkup(createElement(NodeFills, { node, tokens }));
    expect(html.includes("data-fill-stack")).toBe(fillStack);
    if (paints.every((paint) => !paint.visible)) expect(html).not.toContain("data-fill-id");
  });
}
