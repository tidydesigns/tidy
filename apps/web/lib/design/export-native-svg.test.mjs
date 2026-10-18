import { afterEach, expect, test } from "bun:test";
import { nativeSvg } from "./export-native-svg";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { vectorSvg } from "@tidy/design-renderer/vector-path";

const originalParser = globalThis.DOMParser;
const originalSerializer = globalThis.XMLSerializer;
afterEach(() => {
  globalThis.DOMParser = originalParser;
  globalThis.XMLSerializer = originalSerializer;
});

test("native vector exports regenerate design geometry instead of parsing DOM image content", () => {
  const node = parseDesignDocument({
    ...blankDesignDocument(),
    nodes: [
      {
        ...buildDrawnNode("vector", "container", null, { x: 0, y: 0, width: 100, height: 50 }),
        type: "vector",
        vectorPath: {
          d: "M0 0L100 0L100 50Z",
          viewBox: { x: 0, y: 0, width: 100, height: 50 },
          fillRule: "nonzero",
        },
      },
    ],
  }).nodes[0];
  const parsedSources = [];
  globalThis.DOMParser = class {
    parseFromString(source, mime) {
      expect(mime).toBe("image/svg+xml");
      parsedSources.push(source);
      return {
        querySelector: () => null,
        documentElement: {
          source,
          attributes: [],
          querySelectorAll: () => [],
          setAttribute() {},
        },
      };
    }
  };
  globalThis.XMLSerializer = class {
    serializeToString(element) {
      return element.source;
    }
  };
  for (const payload of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><foreignObject/></svg>',
  ]) {
    // This image is inert on the canvas, but decoding its URL into an inline SVG
    // would turn its active content into executable content in an exported file.
    const image = { src: `data:image/svg+xml,${encodeURIComponent(payload)}` };
    const clone = {
      dataset: { nodeId: node.id, exportWidth: "100", exportHeight: "50" },
      style: {},
      querySelector: () => image,
      children: [],
    };
    const result = nativeSvg([clone], new Map([[node.id, node]]), {}, node.box, 100, 50, "");
    expect(result.unsupported).toEqual([]);
    expect(result.svg).toContain(node.vectorPath.d);
    expect(result.svg).not.toContain("script");
    expect(result.svg).not.toContain("onload");
    expect(result.svg).not.toContain("foreignObject");
  }
  expect(parsedSources).toEqual([vectorSvg(node, {}), vectorSvg(node, {})]);
});
