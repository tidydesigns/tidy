import { nativeSvg } from "@tidy/editor/design/export-native-svg";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "@tidy/design/document";

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
    const parsed = new DOMParser().parseFromString(result.svg, "image/svg+xml");
    if (parsed.querySelector("parsererror, script, foreignObject, [onload], [onerror]"))
      throw new Error("Unsafe or invalid native SVG export.");
    results.push(result);
  }
}
globalThis.__tidyExportSecurityResult = results;
