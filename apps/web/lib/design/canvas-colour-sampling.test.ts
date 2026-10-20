import { expect, test } from "bun:test";
import { buildDrawnNode, type DesignNode, type DesignPaint } from "./document";
import {
  firstCanvasColour,
  nodePaintHit,
  pointOnBorder,
  textSampleTransform,
} from "../../../../packages/editor/src/editor/canvas-colour-sampling";

const solid = (color: string): DesignPaint => ({
  id: color,
  type: "solid",
  color,
  visible: true,
  opacity: 1,
});
const node = (style: DesignNode["style"]): DesignNode => ({
  ...buildDrawnNode("sample", "container", null, { x: 0, y: 0, width: 100, height: 60 }),
  style,
});
const sample = (style: DesignNode["style"], onBorder = false) =>
  nodePaintHit({ node: node(style), tokens: {}, onBorder });

test("text-box whitespace falls through to orange, painted text wins, and unsupported foregrounds block the background", () => {
  const background = sample({ fill: "#ff5d00" });
  expect(firstCanvasColour([{ kind: "transparent" }, background])).toBe("#ff5d00");
  expect(firstCanvasColour([{ kind: "colour", colour: "#1e1e1e" }, background])).toBe("#1e1e1e");
  expect(firstCanvasColour([{ kind: "unsupported" }, background])).toBeUndefined();
});

test("sampling distinguishes an input fill, its stroke and an unpainted interior", () => {
  const style = { fill: "#f2f2f0", borderWidth: 4, borderColor: "#c7c7c7" };
  expect(sample(style)).toEqual({ kind: "colour", colour: "#f2f2f0" });
  expect(sample(style, true)).toEqual({ kind: "colour", colour: "#c7c7c7" });
  expect(sample({ borderWidth: 4, borderColor: "#c7c7c7" })).toEqual({ kind: "transparent" });
});

test("sampling resolves token alpha and falls back to the literal when the token is missing", () => {
  const layer = node({ fill: "#123456", fillToken: "brand" });
  expect(nodePaintHit({ node: layer, tokens: { brand: "#22735980" }, onBorder: false })).toEqual({
    kind: "colour",
    colour: "#22735980",
  });
  expect(nodePaintHit({ node: layer, tokens: {}, onBorder: false })).toEqual({
    kind: "colour",
    colour: "#123456",
  });
});

test("hidden, zero-opacity and fully transparent paints cannot steal a sample; partial alpha survives", () => {
  expect(
    sample({
      paints: [
        { ...solid("#000000"), visible: false },
        { ...solid("#111111"), opacity: 0 },
        solid("#00000000"),
        solid("#ff5d0080"),
      ],
    }),
  ).toEqual({ kind: "colour", colour: "#ff5d0080" });
  expect(sample({ opacity: 0, fill: "#ff5d00" })).toEqual({ kind: "transparent" });
});

test("independent border widths include the inner edge but exclude the fill interior and outside", () => {
  const size = { width: 100, height: 60 },
    widths = [2, 4, 6, 8] as const;
  for (const point of [
    { x: 50, y: 1 },
    { x: 96, y: 30 },
    { x: 50, y: 54 },
    { x: 7, y: 30 },
  ])
    expect(pointOnBorder({ point, size, widths })).toBe(true);
  for (const point of [
    { x: 8, y: 2 },
    { x: -1, y: 30 },
    { x: 100, y: 30 },
  ])
    expect(pointOnBorder({ point, size, widths })).toBe(false);
});

const glyph = {
  matrix: { a: 1, b: 0, c: 0, d: 1 },
  line: { left: 10, top: 20, width: 30, height: 10 },
  metrics: { width: 30, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 },
  point: { x: 12.8, y: 22.1 },
};

test("glyph sampling uses the containing screen pixel through zoom and rotation", () => {
  expect(textSampleTransform(glyph)).toEqual([1, 0, 0, 1, -2, -2]);
  expect(
    textSampleTransform({
      ...glyph,
      matrix: { a: 0.5, b: 0, c: 0, d: 0.5 },
      line: { left: 100, top: 200, width: 15, height: 5 },
      point: { x: 101.5, y: 201.5 },
    }),
  ).toEqual([0.5, 0, 0, 0.5, -1, -1]);
  expect(
    textSampleTransform({
      ...glyph,
      matrix: { a: 0, b: 1, c: -1, d: 0 },
      line: { left: 50, top: 60, width: 10, height: 30 },
      point: { x: 55.2, y: 75.2 },
    }),
  ).toEqual([0, 1, -1, 0, 5, -15]);
});

test("invalid font measurements and collapsed transforms cannot reach canvas drawing", () => {
  expect(
    textSampleTransform({ ...glyph, metrics: { ...glyph.metrics, fontBoundingBoxAscent: NaN } }),
  ).toBeUndefined();
  expect(textSampleTransform({ ...glyph, matrix: { ...glyph.matrix, a: 0 } })).toBeUndefined();
});
