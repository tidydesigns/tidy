import { expect, test } from "bun:test";
import { buildDrawnNode, type DesignNode, type DesignPaint } from "./document";
import {
  firstCanvasColour,
  nodePaintHit,
  pointOnBorder,
  textSampleTransform,
  type ColourHit,
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

test("transparent text-box space reveals the orange paint beneath it", () => {
  expect(firstCanvasColour([{ kind: "transparent" }, sample({ fill: "#ff5d00" })])).toBe("#ff5d00");
});

test("a painted text glyph wins over its orange background", () => {
  expect(
    firstCanvasColour([{ kind: "colour", colour: "#1e1e1e" }, sample({ fill: "#ff5d00" })]),
  ).toBe("#1e1e1e");
});

test("an unsupported foreground stops sampling instead of picking an unrelated layer below", () => {
  function* hits(): Generator<ColourHit> {
    yield { kind: "transparent" };
    yield { kind: "unsupported" };
    throw new Error("The occluded background must not be read.");
  }
  expect(firstCanvasColour(hits())).toBeUndefined();
  expect(firstCanvasColour([])).toBeUndefined();
});

test("a successful pick stops inspecting lower layers immediately", () => {
  function* hits(): Generator<ColourHit> {
    yield { kind: "colour", colour: "#ff5d00" };
    throw new Error("No additional hit testing is needed after the visible colour.");
  }
  expect(firstCanvasColour(hits())).toBe("#ff5d00");
});

test("the input interior samples its fill and its border samples the stroke", () => {
  const style = { fill: "#f2f2f0", borderWidth: 4, borderColor: "#c7c7c7" };
  expect(sample(style)).toEqual({ kind: "colour", colour: "#f2f2f0" });
  expect(sample(style, true)).toEqual({ kind: "colour", colour: "#c7c7c7" });
});

test("a stroke without a fill does not paint the empty interior", () => {
  const style = { borderWidth: 4, borderColor: "#c7c7c7" };
  expect(sample(style)).toEqual({ kind: "transparent" });
  expect(sample(style, true)).toEqual({ kind: "colour", colour: "#c7c7c7" });
});

test("solid colour tokens resolve with source alpha intact and missing tokens fall back to the literal", () => {
  const layer = node({ fill: "#123456", fillToken: "brand" });
  expect(nodePaintHit({ node: layer, tokens: { brand: "#22735980" }, onBorder: false })).toEqual({
    kind: "colour",
    colour: "#22735980",
  });
  expect(nodePaintHit({ node: layer, tokens: {}, onBorder: false })).toEqual({
    kind: "colour",
    colour: "#123456",
  });
  expect(sample({ fill: "#ABCDEF80" })).toEqual({ kind: "colour", colour: "#abcdef80" });
});

test("hidden and zero-opacity paint layers cannot steal the sample", () => {
  expect(
    sample({
      paints: [
        { ...solid("#000000"), visible: false },
        { ...solid("#111111"), opacity: 0 },
        solid("#ff5d00"),
      ],
    }),
  ).toEqual({ kind: "colour", colour: "#ff5d00" });
  expect(sample({ opacity: 0, fill: "#ff5d00" })).toEqual({ kind: "transparent" });
  expect(
    nodePaintHit({
      node: { ...node({ fill: "#ff5d00" }), visible: false },
      tokens: {},
      onBorder: false,
    }),
  ).toEqual({ kind: "transparent" });
});

test("fully transparent hex paints reveal lower paints while partial alpha remains editable", () => {
  expect(sample({ paints: [solid("#00000000"), solid("#ff5d0080")] })).toEqual({
    kind: "colour",
    colour: "#ff5d0080",
  });
  expect(sample({ fill: "#00000000" })).toEqual({ kind: "transparent" });
});

test("malformed colours, gradients and image paints are explicit unsupported hits", () => {
  expect(sample({ fill: "not-a-colour" })).toEqual({ kind: "unsupported" });
  expect(
    sample({
      paints: [{ id: "gradient", type: "linear", angle: 90, stops: [], visible: true, opacity: 1 }],
    }),
  ).toEqual({ kind: "unsupported" });
  expect(
    sample({
      paints: [
        {
          id: "image",
          type: "image",
          fit: "cover",
          positionX: 50,
          positionY: 50,
          visible: true,
          opacity: 1,
        },
      ],
    }),
  ).toEqual({ kind: "unsupported" });
});

test("independent border widths use half-open edges and do not select the interior or outside", () => {
  const size = { width: 100, height: 60 };
  const widths = [2, 4, 6, 8] as const;
  for (const point of [
    { x: 50, y: 1 },
    { x: 96, y: 30 },
    { x: 50, y: 54 },
    { x: 7, y: 30 },
  ])
    expect(pointOnBorder({ point, size, widths })).toBe(true);
  for (const point of [
    { x: 8, y: 2 },
    { x: 50, y: 30 },
    { x: -1, y: 30 },
    { x: 100, y: 30 },
    { x: 50, y: 60 },
  ])
    expect(pointOnBorder({ point, size, widths })).toBe(false);
  expect(pointOnBorder({ point: { x: 0, y: 0 }, size, widths: [0, 0, 0, 0] })).toBe(false);
});

const metrics = { width: 30, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 };
const identity = { a: 1, b: 0, c: 0, d: 1 };

test("glyph sampling targets the containing screen pixel rather than rounding to a neighbouring pixel", () => {
  expect(
    textSampleTransform({
      matrix: identity,
      line: { left: 10, top: 20, width: 30, height: 10 },
      metrics,
      point: { x: 12.8, y: 22.1 },
    }),
  ).toEqual([1, 0, 0, 1, -2, -2]);
});

test("glyph sampling preserves zoom, rotation and horizontal flips", () => {
  expect(
    textSampleTransform({
      matrix: { a: 0.5, b: 0, c: 0, d: 0.5 },
      line: { left: 100, top: 200, width: 15, height: 5 },
      metrics,
      point: { x: 101.5, y: 201.5 },
    }),
  ).toEqual([0.5, 0, 0, 0.5, -1, -1]);
  expect(
    textSampleTransform({
      matrix: { a: 0, b: 1, c: -1, d: 0 },
      line: { left: 50, top: 60, width: 10, height: 30 },
      metrics,
      point: { x: 55.2, y: 75.2 },
    }),
  ).toEqual([0, 1, -1, 0, 5, -15]);
  expect(
    textSampleTransform({
      matrix: { a: -1, b: 0, c: 0, d: 1 },
      line: { left: 10, top: 20, width: 30, height: 10 },
      metrics,
      point: { x: 12, y: 22 },
    }),
  ).toEqual([-1, 0, 0, 1, 28, -2]);
});

test("invalid font measurements and collapsed or non-finite transforms never reach canvas drawing", () => {
  const line = { left: 10, top: 20, width: 30, height: 10 };
  const point = { x: 12, y: 22 };
  expect(
    textSampleTransform({ matrix: identity, line, metrics: { ...metrics, width: 0 }, point }),
  ).toBeUndefined();
  expect(
    textSampleTransform({
      matrix: identity,
      line,
      metrics: { ...metrics, fontBoundingBoxAscent: NaN },
      point,
    }),
  ).toBeUndefined();
  expect(
    textSampleTransform({ matrix: { ...identity, a: 0 }, line, metrics, point }),
  ).toBeUndefined();
  expect(
    textSampleTransform({ matrix: { ...identity, a: Infinity }, line, metrics, point }),
  ).toBeUndefined();
  expect(
    textSampleTransform({ matrix: identity, line, metrics, point: { ...point, x: NaN } }),
  ).toBeUndefined();
});
