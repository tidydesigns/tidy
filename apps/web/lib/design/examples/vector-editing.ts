import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "../document";
import { parsePathContours, serializeContours } from "@bella/design/vector-geometry";

/** Development-only browser fixture exercises native paths and transformed ancestors. */
export function buildVectorEditingDocument() {
  const contours = parsePathContours("M20 30 C40 5 120 5 140 30 L140 100 L20 100 Z");
  return parseDesignDocument({
    ...blankDesignDocument(),
    nodes: [
      {
        ...buildDrawnNode("frame", "artboard", null, { x: 40, y: 40, width: 620, height: 440 }),
        style: { fill: "#ffffff" },
      },
      {
        ...buildDrawnNode("rotated", "container", "frame", {
          x: 140,
          y: 100,
          width: 280,
          height: 220,
        }),
        style: { rotation: 25, flipX: true },
      },
      {
        ...buildDrawnNode("editable-path", "container", "rotated", {
          x: 50,
          y: 50,
          width: 160,
          height: 120,
        }),
        name: "Editable path",
        type: "vector",
        style: {
          paints: [{ id: "fill", type: "solid", color: "#ff6600", opacity: 1, visible: true }],
          strokePaints: [
            { id: "stroke", type: "solid", color: "#111111", opacity: 1, visible: true },
          ],
          borderWidth: 2,
          rotation: -10,
        },
        vectorPath: {
          contours,
          d: serializeContours(contours),
          viewBox: { x: 0, y: 0, width: 160, height: 120 },
          fillRule: "nonzero",
        },
      },
    ],
  });
}
