import { nativeSvg } from "@tidy/editor/design/export-native-svg";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "@tidy/design/document";
import { vectorSvg } from "@tidy/design-renderer/vector-path";
import { strokeSvg } from "@tidy/design-renderer/strokes";
import { paintDefinition } from "@tidy/design-renderer/paints";

function assertPassive(svg) {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (parsed.querySelector("parsererror, script, foreignObject"))
    throw new Error("Unsafe or invalid native SVG export.");
  for (const element of parsed.querySelectorAll("*"))
    if ([...element.attributes].some((attribute) => /^on/i.test(attribute.localName)))
      throw new Error("An injected event attribute reached the SVG export.");
}

const node = parseDesignDocument({
  ...blankDesignDocument(),
  nodes: [
    {
      ...buildDrawnNode("vector", "container", null, { x: 0, y: 0, width: 100, height: 50 }),
      type: "vector",
      style: { fill: "#ff0000", borderWidth: 2, borderColor: "#000000" },
      vectorPath: {
        d: "M0 0L100 0L100 50Z",
        viewBox: { x: 0, y: 0, width: 100, height: 50 },
        fillRule: "nonzero",
      },
    },
  ],
}).nodes[0];
const results = [];
for (const payload of [
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><foreignObject/></svg>',
]) {
  for (const source of [
    `data:image/svg+xml,${encodeURIComponent(payload)}`,
    `data:image/svg+xml;base64,${btoa(payload)}`,
  ]) {
    const clone = document.createElement("div");
    clone.dataset.nodeId = node.id;
    clone.dataset.exportWidth = "100";
    clone.dataset.exportHeight = "50";
    const image = document.createElement("img");
    image.dataset.vectorPath = "";
    image.src = source;
    clone.append(image);
    const result = nativeSvg([clone], new Map([[node.id, node]]), {}, node.box, 100, 50, "");
    assertPassive(result.svg);
    results.push(result);
  }
}

// Public serializers must escape their inputs even when a caller bypasses the
// document schema. Exercise text, numeric, token and DOM attribute boundaries.
const injection = '\"/><script>alert(1)</script><g onload="alert(1)';
const raw = {
  ...node,
  vectorPath: { ...node.vectorPath, d: injection, fillRule: injection },
  style: {
    ...node.style,
    strokeCap: injection,
    strokeJoin: injection,
    strokeStart: "circle",
    strokeEnd: "triangle",
    paints: [
      {
        id: "fill",
        type: "solid",
        color: "#000000",
        token: "ink",
        visible: true,
        opacity: injection,
        blendMode: injection,
      },
    ],
    strokePaints: [
      { id: "stroke", type: "solid", color: "#000000", token: "ink", visible: true, opacity: 1 },
    ],
  },
};
assertPassive(vectorSvg(raw, { ink: injection }));
assertPassive(strokeSvg(raw, { ink: injection }, { width: injection, height: injection }));
for (const type of ["linear", "radial"]) {
  const definition = paintDefinition(
    {
      type,
      visible: true,
      opacity: 1,
      angle: 0,
      centerX: 0.5,
      centerY: 0.5,
      radiusX: 0.5,
      radiusY: 0.5,
      rotation: injection,
      stops: [{ id: "stop", position: injection, color: "#000000", token: "ink" }],
    },
    injection,
    { width: 100, height: 50 },
    { ink: injection },
  );
  assertPassive(`<svg xmlns="http://www.w3.org/2000/svg">${definition.definition}</svg>`);
}
const clone = document.createElement("div");
clone.dataset.nodeId = "plain";
clone.dataset.exportWidth = "100";
clone.dataset.exportHeight = "50";
clone.dataset.exportMatrix = injection;
const plain = {
  ...node,
  id: "plain",
  type: "container",
  vectorPath: undefined,
  style: { fill: "#ff0000", opacity: injection, blendMode: injection },
};
assertPassive(
  nativeSvg(
    [clone],
    new Map([[plain.id, plain]]),
    {},
    { width: injection, height: injection },
    injection,
    injection,
    "</style><script>alert(1)</script>",
  ).svg,
);
globalThis.__tidyExportSecurityResult = results;
