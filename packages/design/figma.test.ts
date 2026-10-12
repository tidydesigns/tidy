import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  importFigma,
  isFigmaClipboard,
  decodeFigma,
  figmaClipboardBytes,
  figmaPages,
  convertFigma,
} from "./figma";
import { assembleCanvasFig, encodeFigParts, type FigNode } from "openfig-core";
import { deflateSync } from "fflate";
import { encodeBinarySchema } from "kiwi-schema";
const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../../apps/web/scripts/fixtures/figma/${name}`, import.meta.url)),
  );
function encode(nodes: FigNode[]) {
  const doc = decodeFigma(fixture("circle.fig"));
  doc.message = { ...(doc.message as object), nodeChanges: nodes };
  const parts = encodeFigParts(doc);
  return assembleCanvasFig({
    prelude: "fig-kiwi",
    version: parts.version,
    schemaCompressed: parts.schemaCompressed,
    messageCompressed: deflateSync(parts.messageRaw),
  });
}
describe("native Figma import", () => {
  test("real exported frame/ellipse retain hierarchy, bounds, fill and stroke", () => {
    const result = importFigma(fixture("circle.fig"));
    expect(result.document.nodes).toHaveLength(2);
    const [frame, ellipse] = result.document.nodes;
    expect(frame.box.width).toBe(350);
    expect(frame.style.borderWidth).toBe(0);
    expect(ellipse.parentId).toBe(frame.id);
    expect(ellipse.box).toEqual({ x: 25, y: 25, width: 300, height: 300 });
    expect(ellipse.type).toBe("vector");
    expect(ellipse.style.paints?.[0]).toMatchObject({ type: "solid", color: "#ff0000ff" });
    expect(ellipse.style.borderWidth).toBe(5);
    expect(result.document.warnings).toHaveLength(0);
  });
  test("real vector export retains all path regions", () => {
    const result = importFigma(fixture("vector.fig"));
    expect(result.document.nodes[1].vectorPath?.d.length).toBeGreaterThan(7000);
    expect(result.document.nodes[1].parentId).toBe(result.document.nodes[0].id);
  });
  test("real clipboard group respects paint order and RGB colours", () => {
    const bytes = figmaClipboardBytes(new TextDecoder().decode(fixture("group.clipboard.html")));
    const result = importFigma(bytes);
    expect(result.document.nodes.map((n) => n.name)).toEqual(["group", "red", "green", "blue"]);
    expect(result.document.nodes.slice(1).map((n) => n.style.paints?.[0])).toMatchObject([
      { color: "#ff0000ff" },
      { color: "#00ff00ff" },
      { color: "#0000ffff" },
    ]);
  });
  test("browser-sanitized clipboard HTML retains native markers", () => {
    const html = new TextDecoder()
      .decode(fixture("group.clipboard.html"))
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    expect(isFigmaClipboard(html)).toBe(true);
    expect(importFigma(figmaClipboardBytes(html)).document.nodes).toHaveLength(4);
  });
  test("rejects malformed clipboard and truncated archives", () => {
    expect(() => figmaClipboardBytes("<!--(figma)@@@@(/figma)-->")).toThrow("invalid");
    expect(() => decodeFigma(new Uint8Array([0, 1]))).toThrow("Figma Design");
    const bytes = encode([]);
    expect(() => decodeFigma(bytes.slice(0, -1))).toThrow("truncated");
  });
  test("pixel text line height stays pixels instead of a CSS multiplier", () => {
    const doc = decodeFigma(fixture("circle.fig"));
    const nodes = [
      ...doc.nodes.filter((n) => n.type === "DOCUMENT" || (n.type === "CANVAS" && !n.internalOnly)),
      {
        guid: { sessionID: 9, localID: 1 },
        parentIndex: { guid: { sessionID: 0, localID: 1 }, position: "!" },
        type: "TEXT",
        name: "Label",
        size: { x: 150, y: 30 },
        fontSize: 20,
        lineHeight: { units: "PIXELS", value: 24 },
        textData: { characters: "Editable label" },
        fontName: { family: "Arial", style: "SemiBold", postscript: "" },
        letterSpacing: { units: "PERCENT", value: 5 },
      } as FigNode,
    ];
    const result = importFigma(encode(nodes));
    expect(result.document.nodes[0].style).toMatchObject({
      lineHeightMode: "px",
      lineHeightPx: 24,
      fontWeight: 600,
      letterSpacing: 1,
    });
  });
  test("selected pages preserve their identity and never include hidden library canvas", () => {
    const doc = decodeFigma(fixture("circle.fig"));
    expect(figmaPages(doc)).toEqual([{ id: "0:1", name: "Page 1", nodeCount: 2 }]);
    const result = convertFigma(doc, "Circle", ["0:1"]);
    expect(result.document.pages).toHaveLength(1);
    expect(result.document.nodes.every((n) => n.pageId === result.document.pages![0].id)).toBe(
      true,
    );
  });
  test("cycles and oversized selections cannot silently truncate", () => {
    const doc = decodeFigma(fixture("circle.fig"));
    const root = doc.nodes.find((n) => n.type === "FRAME")!;
    doc.childrenMap.get("1:3")!.push(root);
    expect(() => convertFigma(doc)).toThrow("cyclic");
  });
});

test("stroke-only Figma vectors import their outline geometry instead of disappearing", () => {
  const original = decodeFigma(fixture("line.fig"));
  const result = convertFigma(original);
  const vector = result.document.nodes.find((node) => node.type === "vector");
  expect(vector?.vectorPath?.d.length).toBeGreaterThan(20);
  expect(vector?.style.borderWidth).toBe(0);
  expect(vector?.style.paints?.length).toBeGreaterThan(0);
  expect(
    result.document.warnings.some((warning) => warning.message.includes("outline paths")),
  ).toBe(true);
});

test("component instances retain their source and per-child fill overrides", () => {
  const doc = decodeFigma(fixture("circle.fig"));
  const master = doc.nodes.find((node) => node.type === "FRAME")!;
  const base = doc.nodes.map((node) =>
    node === master ? { ...node, type: "SYMBOL", name: "Badge" } : node,
  );
  base.push({
    guid: { sessionID: 8, localID: 1 },
    parentIndex: { guid: { sessionID: 0, localID: 1 }, position: "~" },
    type: "INSTANCE",
    name: "Badge instance",
    size: { x: 350, y: 350 },
    transform: { m00: 1, m01: 0, m02: 400, m10: 0, m11: 1, m12: 0 },
    symbolData: {
      symbolID: master.guid,
      symbolOverrides: [
        {
          guidPath: { guids: [{ sessionID: 1, localID: 2 }] },
          fillPaints: [
            { type: "SOLID", color: { r: 0, g: 1, b: 0, a: 1 }, opacity: 1, visible: true },
          ],
        },
      ],
    },
  } as FigNode);
  const result = importFigma(encode(base));
  const component = result.document.nodes.find((node) => node.isComponent)!;
  const instance = result.document.nodes.find((node) => node.name === "Badge instance")!;
  const copy = result.document.nodes.find((node) => node.parentId === instance.id)!;
  expect(instance.instanceOf).toBe(component.id);
  expect(copy.instanceOf).toBe(component.id);
  expect(copy.componentSourceId).toBe(
    result.document.nodes.find((node) => node.parentId === component.id)!.id,
  );
  expect(copy.style.paints?.[0]).toMatchObject({ type: "solid", color: "#00ff00ff" });
  expect(copy.instanceOverrides).toContain("style.paints");
});

test("horizontal Auto Layout, padding, fill sizing and text alignment retain native rules", () => {
  const doc = decodeFigma(fixture("circle.fig"));
  const root = doc.nodes.find((node) => node.type === "FRAME")!;
  const nodes = doc.nodes.map((node) =>
    node === root
      ? {
          ...node,
          stackMode: "HORIZONTAL",
          stackSpacing: 16,
          stackHorizontalPadding: 12,
          stackVerticalPadding: 8,
          stackPrimaryAlignItems: "CENTER",
          stackCounterAlignItems: "CENTER",
        }
      : node,
  );
  nodes.push({
    guid: { sessionID: 8, localID: 2 },
    type: "TEXT",
    name: "Flexible text",
    parentIndex: { guid: root.guid, position: "~" },
    size: { x: 100, y: 24 },
    fontSize: 16,
    fontName: { family: "Arial", style: "Regular", postscript: "" },
    textData: { characters: "Resize me" },
    textAlignVertical: "CENTER",
    stackChildPrimaryGrow: 1,
    textAutoResize: "HEIGHT",
  } as FigNode);
  const result = importFigma(encode(nodes));
  expect(result.document.nodes[0]).toMatchObject({
    layout: "flex-row",
    gap: 16,
    paddingLeft: 12,
    paddingTop: 8,
    justify: "center",
    align: "center",
  });
  const text = result.document.nodes.find((node) => node.type === "text")!;
  expect(text).toMatchObject({
    widthMode: "fill",
    heightMode: "hug",
    style: { textVerticalAlign: "center" },
  });
});

test("rejects attacker-controlled schema names before compiling code", () => {
  const doc = decodeFigma(fixture("circle.fig"));
  const schema = structuredClone(doc.schema);
  schema.definitions[0].name = "__proto__";
  const bytes = assembleCanvasFig({
    prelude: "fig-kiwi",
    version: doc.header.version,
    schemaCompressed: deflateSync(encodeBinarySchema(schema)),
    messageCompressed: deflateSync(new Uint8Array()),
  });
  expect(() => decodeFigma(bytes)).toThrow("Unsupported Figma schema");
});

test("compressed schema cannot exceed its expansion budget", () => {
  const bytes = assembleCanvasFig({
    prelude: "fig-kiwi",
    version: 1,
    schemaCompressed: deflateSync(new Uint8Array(2_000_001)),
    messageCompressed: deflateSync(new Uint8Array()),
  });
  expect(() => decodeFigma(bytes)).toThrow("Expanded Figma data is too large");
});

test("invalid page choices and more than 10,000 layers fail explicitly", () => {
  const doc = decodeFigma(fixture("circle.fig"));
  expect(() => convertFigma(doc, "Fixture", [])).toThrow();
  expect(() => convertFigma(doc, "Fixture", ["missing"])).toThrow("unavailable");
  const root = doc.nodes.find((node) => node.type === "FRAME")!;
  const children = doc.childrenMap.get(`${root.guid.sessionID}:${root.guid.localID}`)!;
  for (let i = 0; i < 10_000; i++) {
    const child = { ...children[0], guid: { sessionID: 123, localID: i } };
    doc.nodes.push(child);
    doc.nodeMap.set(`123:${i}`, child);
    children.push(child);
  }
  expect(() => convertFigma(doc)).toThrow("10,000 editable layers");
});
