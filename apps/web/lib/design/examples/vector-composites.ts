import {
  blankDesignDocument,
  buildDrawnNode,
  parseDesignDocument,
  type DesignNode,
} from "../document";
import { createVectorBoolean, createVectorMask } from "../vector-composite-operations";

export function buildVectorCompositeDocument() {
  const assetId = "00000000-0000-4000-8000-000000000033";
  const path = (
    id: string,
    name: string,
    x: number,
    y: number,
    d: string,
    color = "#ff6600",
  ): DesignNode => ({
    ...buildDrawnNode(id, "container", "frame", { x, y, width: 140, height: 140 }),
    name,
    type: "vector",
    assetId,
    positionMode: "absolute",
    vectorPath: { d, viewBox: { x: 0, y: 0, width: 140, height: 140 }, fillRule: "nonzero" },
    style: {
      paints: [{ id: "fill", type: "solid", color, opacity: 1, visible: true }],
      strokePaints: [],
    },
  });
  const rectangle = "M0 0H140V140H0Z",
    circle = "M140 70A70 70 0 1 1 0 70A70 70 0 1 1 140 70Z";
  let document = parseDesignDocument({
    ...blankDesignDocument(),
    nodes: [
      {
        ...buildDrawnNode("frame", "artboard", null, { x: 40, y: 40, width: 740, height: 420 }),
        name: "Composite frame",
        style: { fill: "#ffffff" },
      },
      path("first", "First path", 40, 40, circle),
      path("second", "Second path", 110, 40, rectangle),
      {
        ...path("mask-source", "Mask source", 380, 40, circle, "#ffffff"),
        style: {
          rotation: 20,
          flipX: true,
          paints: [
            {
              id: "gradient",
              type: "linear",
              angle: 90,
              opacity: 1,
              visible: true,
              stops: [
                { id: "black", position: 0, color: "#000000" },
                { id: "white", position: 1, color: "#ffffff" },
              ],
            },
          ],
          strokePaints: [],
        },
      },
      {
        ...buildDrawnNode("masked-content", "container", "frame", {
          x: 340,
          y: 20,
          width: 240,
          height: 190,
        }),
        name: "Masked content",
        positionMode: "absolute",
        style: { fill: "#ff6600" },
      },
      {
        ...buildDrawnNode("mask-text", "text", "masked-content", {
          x: 70,
          y: 80,
          width: 120,
          height: 30,
        }),
        name: "Masked text",
        text: "TIDY",
        style: { fontSize: 24, fontWeight: 700, color: "#111111" },
      },
      path("third", "Third path", 70, 245, circle),
      path("fourth", "Fourth path", 145, 245, rectangle),
    ],
  });
  document = createVectorBoolean(document, ["first", "second"], "union", "boolean-group");
  document = createVectorMask(
    document,
    ["mask-source", "masked-content"],
    "mask-source",
    "mask-group",
  );
  return document;
}
