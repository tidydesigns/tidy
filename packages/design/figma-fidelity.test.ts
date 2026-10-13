import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import type { FigNode } from "openfig-core";
import { decodeFigma, convertFigma } from "./figma";
import { figmaFontWeight, figmaRichText } from "./figma-text";
import { imageMaskPaint } from "./vector-relationships";

function convert(children: FigNode[]) {
  const document = decodeFigma(
    new Uint8Array(
      readFileSync(new URL("../../apps/web/scripts/fixtures/figma/circle.fig", import.meta.url)),
    ),
  );
  const page = document.nodes.find((node) => node.type === "CANVAS" && !node.internalOnly)!;
  document.nodes = [page, ...children];
  document.nodeMap = new Map(
    document.nodes.map((n) => [`${n.guid.sessionID}:${n.guid.localID}`, n]),
  );
  document.childrenMap = new Map();
  for (const n of children) {
    const id = `${n.parentIndex!.guid.sessionID}:${n.parentIndex!.guid.localID}`;
    const siblings = document.childrenMap.get(id) ?? [];
    siblings.push(n);
    document.childrenMap.set(id, siblings);
  }
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47]);
  png.set(new TextEncoder().encode("IHDR"), 12);
  const header = new DataView(png.buffer);
  header.setUint32(16, 100);
  header.setUint32(20, 100);
  document.images.set("image", png);
  return convertFigma(document).document;
}
function layer(id: number, parent = 0): FigNode {
  return {
    guid: { sessionID: 9, localID: id },
    parentIndex: {
      guid: parent ? { sessionID: 9, localID: parent } : { sessionID: 0, localID: 1 },
      position: String(id),
    },
    name: `Layer ${id}`,
    type: "RECTANGLE",
    size: { x: 100, y: 100 },
    transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 20 },
    fillPaints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }],
  };
}

test("space-evenly remains native Auto Layout, including fill and absolute children", () => {
  const root = {
    ...layer(1),
    type: "FRAME",
    stackMode: "HORIZONTAL",
    stackPrimaryAlignItems: "SPACE_EVENLY",
  } as FigNode;
  const document = convert([
    root,
    { ...layer(2, 1), stackChildPrimaryGrow: 1 },
    { ...layer(3, 1), stackPositioning: "ABSOLUTE" },
  ]);
  expect(document.nodes[0]).toMatchObject({ layout: "flex-row", justify: "space-evenly" });
  expect(document.nodes[1]).toMatchObject({ widthMode: "fill", positionMode: "auto" });
  expect(document.nodes[2].positionMode).toBe("absolute");
  expect(document.warnings).toHaveLength(0);
});

test("native text ranges retain marks, base inheritance, blank paragraphs and emoji", () => {
  const node = {
    ...layer(1),
    type: "TEXT",
    fontName: { family: "Arial", style: "Regular" },
    textData: {
      characters: "A😀B\n\nC",
      characterStyleIDs: [0, 2, 2, 3, 0, 0, 2],
      styleOverrideTable: [
        {
          styleID: 2,
          fontName: { family: "Arial", style: "Bold Italic" },
          textDecoration: "UNDERLINE",
        },
        { styleID: 3, textDecoration: "STRIKETHROUGH" },
      ],
    },
  } as FigNode;
  const rich = figmaRichText(node);
  expect(rich.unsupported).toBe(false);
  expect(rich.richText).toEqual([
    {
      runs: [
        { text: "A" },
        { text: "😀", bold: true, italic: true, underline: true, strike: false },
        { text: "B", underline: false, strike: true },
      ],
    },
    { runs: [{ text: "" }] },
    { runs: [{ text: "C", bold: true, italic: true, underline: true, strike: false }] },
  ]);
  expect(convert([node]).nodes[0].richText).toEqual(rich.richText);
});

test("unsupported range colors and fonts retain supported marks and a warning", () => {
  const node = {
    ...layer(1),
    type: "TEXT",
    textData: {
      characters: "Test",
      characterStyleIDs: [5, 5, 5, 5],
      styleOverrideTable: [{ styleID: 5, fontSize: 30, textDecoration: "UNDERLINE" }],
    },
  } as FigNode;
  const result = convert([node]);
  expect(result.nodes[0].richText?.[0].runs[0].underline).toBe(true);
  expect(result.warnings[0].message).toContain("text range styles");
  expect(
    figmaRichText({ ...node, textData: { characters: "x", characterStyleIDs: [99] } } as FigNode)
      .unsupported,
  ).toBe(true);
});

test("font face matching distinguishes thin, extra-light, semi-bold and extra-bold", () => {
  expect(
    ["Thin", "ExtraLight", "Light", "Medium", "SemiBold", "Bold", "ExtraBold", "Black"].map(
      figmaFontWeight,
    ),
  ).toEqual([100, 200, 300, 500, 600, 700, 800, 900]);
});

test("image masks preserve sibling scope and coordinates and stop at the next mask", () => {
  const root = { ...layer(1), type: "FRAME" };
  const mask = {
    ...layer(3, 1),
    mask: true,
    opacity: 0.8,
    fillPaints: [{ type: "IMAGE", image: { hash: "image" } }],
  } as FigNode;
  const result = convert([
    root,
    layer(2, 1),
    mask,
    layer(4, 1),
    { ...layer(5, 1), mask: true },
    layer(6, 1),
  ]);
  const sources = result.nodes.filter((n) => n.mask);
  expect(sources).toHaveLength(2);
  const [imageGroup, vectorGroup] = sources;
  expect(result.nodes.find((n) => n.sourceKey === "9:2")?.parentId).toBe(result.nodes[0].id);
  const source = result.nodes.find((n) => n.sourceKey === "9:3")!;
  expect(source.parentId).toBe(imageGroup.id);
  expect(source.box).toMatchObject({ x: 0, y: 0 });
  expect(imageGroup.box).toMatchObject({ x: 10, y: 20 });
  expect(result.nodes.find((n) => n.sourceKey === "9:4")?.parentId).toBe(imageGroup.id);
  expect(result.nodes.find((n) => n.sourceKey === "9:6")?.parentId).toBe(vectorGroup.id);
  expect(imageMaskPaint(source, result.nodes)?.assetId).toBeDefined();
  expect(result.warnings).toHaveLength(0);
});

test("unsupported image-mask transforms and vector-only mask modes report a gap", () => {
  const mask = {
    ...layer(1),
    mask: true,
    maskType: "VECTOR",
    fillPaints: [{ type: "IMAGE", image: { hash: "image" } }],
  } as FigNode;
  const result = convert([mask, layer(2)]);
  expect(result.nodes.some((n) => n.mask)).toBe(false);
  expect(result.warnings[0].message).toContain("mask source or mode");
});
