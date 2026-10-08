import { test, expect } from "bun:test";
import sharp from "sharp";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { vectorSvg, vectorOutset } from "./vector-path";
import { scaleLayers } from "./layout-operations";
import { resolveVariantNodes } from "./component-variants";
import { nodeStyle } from "./node-style";
import { strokeOutsets } from "./strokes";
import { diffDocument, applyDocumentPatch, invertPatch } from "./document-patch";
import { DocumentPreview } from "@/app/files/thumbnail-renderer";
import { DesignSnapshot } from "@/components/github/design-snapshot";
import { TidyDesign } from "./code-runtime";
import { DesignImage } from "@/components/design/design-image";
const assetId = "22222222-2222-4222-8222-222222222222";
const path = {
  ...buildDrawnNode("path", "container", null, { x: 0, y: 0, width: 100, height: 100 }),
  type: "vector",
  assetId,
  vectorPath: {
    d: "M20 50L80 50",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    fillRule: "nonzero",
  },
  style: { paints: [], borderWidth: 10, borderColor: "#ff0000" },
};
async function pixels(node) {
  const { data, info } = await sharp(Buffer.from(vectorSvg(node, {})))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return (x, y) => {
    const offset = ((y + vectorOutset(node)) * info.width + x + vectorOutset(node)) * 4;
    return [...data.subarray(offset, offset + 4)];
  };
}
test("native path caps, joins and endpoint markers change actual painted pixels", async () => {
  const butt = await pixels(path),
    round = await pixels({ ...path, style: { ...path.style, strokeCap: "round" } });
  expect(butt(17, 50)[3]).toBe(0);
  expect(round(17, 50)).toEqual([255, 0, 0, 255]);
  const bent = { ...path, vectorPath: { ...path.vectorPath, d: "M20 80L50 20L80 80" } };
  const miter = await pixels(bent),
    bevel = await pixels({ ...bent, style: { ...bent.style, strokeJoin: "bevel" } });
  expect(miter(50, 12)[3]).toBeGreaterThan(0);
  expect(bevel(50, 12)[3]).toBe(0);
  const arrow = await pixels({
    ...path,
    style: { ...path.style, strokeStart: "triangle", strokeEnd: "circle" },
  });
  expect(arrow(40, 58)[3]).toBeGreaterThan(0);
  expect(arrow(80, 38)).toEqual([255, 0, 0, 255]);
  expect(butt(30, 58)[3]).toBe(0);
  expect(butt(80, 38)[3]).toBe(0);
});
test("path stroke stacks honor tokens, visibility and opacity without drawing a box border", async () => {
  const node = {
    ...path,
    style: {
      ...path.style,
      strokePaints: [
        { id: "color", type: "solid", color: "#0000ff", token: "ink", opacity: 0.5, visible: true },
      ],
    },
  };
  const svg = vectorSvg(node, { ink: "#00ff00" });
  expect(svg).toContain('stroke="#00ff00"');
  const sample = await pixels(node);
  expect(sample(50, 50)).toEqual([0, 0, 255, 128]);
  expect(sample(0, 50)[3]).toBe(0);
  expect(nodeStyle(node, "absolute", {})).toMatchObject({
    borderTopWidth: 0,
    borderRightWidth: 0,
    background: undefined,
    borderImageSource: undefined,
  });
  expect(strokeOutsets({ ...node, box: { ...node.box, width: 200 } })).toEqual([20, 40, 20, 40]);
  expect(vectorSvg({ ...node, style: { ...node.style, strokePaints: [] } }, {})).not.toContain(
    'stroke-width="10"',
  );
});
test("native paths persist, undo and use one self-contained image across render surfaces", () => {
  const document = parseDesignDocument({ ...blankDesignDocument(), nodes: [path] });
  const changed = parseDesignDocument({
    ...document,
    nodes: [{ ...path, style: { ...path.style, strokeEnd: "arrow", strokeCap: "square" } }],
  });
  const patch = diffDocument(document, changed);
  expect(applyDocumentPatch(document, patch)).toEqual(changed);
  expect(applyDocumentPatch(changed, invertPatch(patch))).toEqual(document);
  const uri = `data:image/svg+xml,${encodeURIComponent(vectorSvg(changed.nodes[0], {}))}`;
  for (const element of [
    createElement(DesignImage, { node: changed.nodes[0], src: "unused" }),
    createElement(DocumentPreview, { content: changed }),
    createElement(DesignSnapshot, { content: changed, frameId: "path", reviewId: "review" }),
    createElement(TidyDesign, { document: changed, rootId: "path", assets: {} }),
  ]) {
    const html = renderToStaticMarkup(element);
    expect(html).toContain(uri);
    expect(html).not.toContain("data-original-src");
  }
  expect(() =>
    parseDesignDocument({
      ...document,
      nodes: [{ ...path, vectorPath: { ...path.vectorPath, d: 'M0 0\" onload=\"alert(1)' } }],
    }),
  ).toThrow();
  expect(() =>
    parseDesignDocument({
      ...document,
      nodes: [{ ...path, vectorPath: { ...path.vectorPath, d: "M1e999 0" } }],
    }),
  ).toThrow();
  expect(() => parseDesignDocument({ ...document, nodes: [{ ...path, type: "image" }] })).toThrow();
});

test("scaling paths does not double-scale strokes and asset variants return to image rendering", () => {
  const document = parseDesignDocument({ ...blankDesignDocument(), nodes: [path] });
  const scaled = scaleLayers(document, [path.id], 2).nodes[0];
  expect(scaled.box.width).toBe(200);
  expect(scaled.style.borderWidth).toBe(10);
  expect(strokeOutsets(scaled)).toEqual([40, 40, 40, 40]);
  const component = {
    ...path,
    isComponent: true,
    variants: {
      default: "replacement",
      options: { replacement: { root: { assetId: "33333333-3333-4333-8333-333333333333" } } },
    },
  };
  expect(resolveVariantNodes([component])[0].vectorPath).toBeUndefined();
});
