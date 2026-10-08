import { test, expect } from "bun:test";
import { designNodeChangesSchema, blankDesignDocument, buildDrawnNode } from "./document";
import {
  defaultGradientLine,
  linearGradientMapping,
  linearGradientAngle,
  setLinearGradientAngle,
  moveLinearEndpoint,
  gradientStopPosition,
  translateLinearGradient,
  applyGradientEdit,
} from "./gradient-geometry";
import { editGradientDocument } from "./gradient-edit";
import { paintBackground } from "./paints";
const size = { width: 400, height: 200 };
const paint = () => ({
  id: "paint",
  type: "linear",
  visible: true,
  opacity: 1,
  angle: 90,
  stops: [
    { id: "a", position: 0, color: "#ff0000" },
    { id: "b", position: 1, color: "#0000ff" },
  ],
});
const near = (actual, expected) => expect(actual).toBeCloseTo(expected, 8);
test("CSS gradient corner projections preserve unpositioned rendering at non-square and extreme sizes", () => {
  for (const size of [
    { width: 400, height: 200 },
    { width: 1, height: 5000 },
    { width: 5000, height: 1 },
  ])
    for (const angle of [0, 30, 45, 90, 180, 300]) {
      const positioned = { ...paint(), angle, ...defaultGradientLine(angle, size) },
        mapping = linearGradientMapping(positioned, size);
      near(mapping.position(0), 0);
      near(mapping.position(1), 1);
      expect(designNodeChangesSchema.safeParse({ style: { paints: [positioned] } }).success).toBe(
        true,
      );
    }
});
test("free endpoints retain both gradient length and offset in the actual padding box", () => {
  const positioned = { ...paint(), start: { x: 0.25, y: 0.3 }, end: { x: 0.75, y: 0.3 } };
  const mapping = linearGradientMapping(positioned, size);
  near(mapping.angle, 90);
  near(mapping.position(0), 0.25);
  near(mapping.position(1), 0.75);
  expect(paintBackground(positioned, {}, size)).toBe(
    "linear-gradient(90deg, #ff0000 25%, #0000ff 75%)",
  );
  const outside = linearGradientMapping(
    { ...positioned, start: { x: -0.5, y: 0 }, end: { x: 1.5, y: 0 } },
    size,
  );
  near(outside.position(0), -0.5);
  near(outside.position(1), 1.5);
});
test("angle edits rotate positioned endpoints around their center and preserve physical length", () => {
  const positioned = { ...paint(), start: { x: 0.25, y: 0.3 }, end: { x: 0.75, y: 0.3 } };
  const rotated = setLinearGradientAngle(positioned, 180, size);
  near((rotated.start.x + rotated.end.x) / 2, 0.5);
  near((rotated.start.y + rotated.end.y) / 2, 0.3);
  near(
    Math.hypot(
      (rotated.end.x - rotated.start.x) * size.width,
      (rotated.end.y - rotated.start.y) * size.height,
    ),
    200,
  );
  near(linearGradientAngle(rotated, size), 180);
  expect(setLinearGradientAngle(paint(), 30, size).start).toBeUndefined();
});
test("endpoint gestures snap physical angles and protect nonzero length; translation retains length", () => {
  const source = { ...paint(), start: { x: 0.1, y: 0.2 }, end: { x: 0.8, y: 0.7 } };
  const edit = moveLinearEndpoint(source, "end", { x: 0.9, y: 0.3 }, size, true),
    next = applyGradientEdit(source, edit, size);
  near(linearGradientAngle(next, size) % 15, 0);
  const overlap = applyGradientEdit(
    source,
    moveLinearEndpoint(source, "end", source.start, size),
    size,
  );
  expect(designNodeChangesSchema.safeParse({ style: { paints: [overlap] } }).success).toBe(true);
  const translated = translateLinearGradient(source, { x: 0.2, y: -0.1 }, size);
  near(translated.end.x - translated.start.x, source.end.x - source.start.x);
  near(translated.end.y - translated.start.y, source.end.y - source.start.y);
});
test("stop projection uses physical coordinates and clamps to the gradient, including radial positions", () => {
  const source = { ...paint(), start: { x: 0, y: 0 }, end: { x: 1, y: 1 } };
  near(gradientStopPosition(source, { x: 0.5, y: 0 }, size), 0.4);
  near(gradientStopPosition(source, { x: 2, y: 2 }, size), 1);
  near(gradientStopPosition(source, { x: -1, y: -1 }, size), 0);
  const base = paint();
  delete base.angle;
  const radial = {
    ...base,
    type: "radial",
    centerX: 0.25,
    centerY: 0.3,
    radiusX: 0.5,
    radiusY: 0.6,
  };
  near(gradientStopPosition(radial, { x: 0.5, y: 0.9 }, size), 0.5);
  const resized = applyGradientEdit(radial, { kind: "radial", radiusX: 0, centerX: 9 }, size);
  expect(resized.radiusX).toBe(0.001);
  expect(resized.centerX).toBe(4);
  expect(designNodeChangesSchema.safeParse({ style: { paints: [resized] } }).success).toBe(true);
});
test("gradient previews merge geometry only, preserving later colors, opacity, other fills and missing targets", () => {
  const node = buildDrawnNode("node", "container", null, { x: 10, y: 20, ...size });
  const latest = {
    ...paint(),
    opacity: 0.4,
    stops: paint().stops.map((stop) => ({ ...stop, color: "#00ff00" })),
  };
  const other = { id: "other", type: "solid", visible: true, opacity: 1, color: "#ffffff" };
  const document = {
    ...blankDesignDocument(),
    nodes: [{ ...node, style: { paints: [latest, other] } }],
  };
  const next = editGradientDocument(
    document,
    "node",
    "paint",
    { kind: "stop", stopId: "a", position: 0.3 },
    size,
  );
  expect(next.nodes[0].box).toEqual(node.box);
  expect(next.nodes[0].style.paints[0]).toMatchObject({
    opacity: 0.4,
    stops: [
      { id: "a", position: 0.3, color: "#00ff00" },
      { id: "b", position: 1, color: "#00ff00" },
    ],
  });
  expect(next.nodes[0].style.paints[1]).toEqual(other);
  expect(
    editGradientDocument(
      document,
      "node",
      "deleted",
      { kind: "stop", stopId: "a", position: 0.3 },
      size,
    ).nodes,
  ).toEqual(document.nodes);
});
test("schema rejects partial, coincident, nonfinite, or out-of-bounds free endpoints", () => {
  for (const geometry of [
    { start: { x: 0, y: 0 } },
    { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
    { start: { x: NaN, y: 0 }, end: { x: 1, y: 1 } },
    { start: { x: -5001, y: 0 }, end: { x: 1, y: 1 } },
  ])
    expect(
      designNodeChangesSchema.safeParse({ style: { paints: [{ ...paint(), ...geometry }] } })
        .success,
    ).toBe(false);
});

test("rotated radial axes and stops use physical geometry at every aspect ratio", async () => {
  const { radialGradientAxes, gradientStopPoint, moveRadialRadius } =
    await import("./gradient-geometry");
  for (const size of [
    { width: 400, height: 200 },
    { width: 100, height: 800 },
  ])
    for (const rotation of [0, 30, 90, -45, 180]) {
      const radial = {
        ...paint(),
        type: "radial",
        centerX: 0.3,
        centerY: 0.6,
        radiusX: 0.4,
        radiusY: 0.2,
        rotation,
      };
      delete radial.angle;
      const axes = radialGradientAxes(radial, size);
      const delta = (point) => ({
        x: (point.x - radial.centerX) * size.width,
        y: (point.y - radial.centerY) * size.height,
      });
      const x = delta(axes.radiusX),
        y = delta(axes.radiusY);
      near(Math.hypot(x.x, x.y), 0.4 * size.width);
      near(Math.hypot(y.x, y.y), 0.2 * size.height);
      near(x.x * y.x + x.y * y.y, 0);
      near(gradientStopPosition(radial, gradientStopPoint(radial, 0.65, size), size), 0.65);
      const point = {
        x: radial.centerX + (axes.radiusY.x - radial.centerX) * 1.5,
        y: radial.centerY + (axes.radiusY.y - radial.centerY) * 1.5,
      };
      const edit = moveRadialRadius(radial, "radiusY", point, size, true);
      near(edit.radiusX, 0.6);
      near(edit.radiusY, 0.3);
      const latest = { ...radial, rotation: rotation + 10, opacity: 0.3 };
      const next = applyGradientEdit(latest, edit, size);
      expect(next.rotation).toBe(rotation + 10);
      expect(next.opacity).toBe(0.3);
    }
});

test("radial rotation patches preserve other fills, token bindings, undo and reopened captures", async () => {
  const { parseDesignDocument } = await import("./document");
  const { diffDocument, applyDocumentPatch, invertPatch } = await import("./document-patch");
  const { webCaptureSchema } = await import("@bella/design/web-capture");
  const radial = {
    ...paint(),
    type: "radial",
    centerX: 0.5,
    centerY: 0.5,
    radiusX: 0.5,
    radiusY: 0.2,
  };
  delete radial.angle;
  radial.stops[0].token = "brand";
  const other = { id: "other", type: "solid", visible: true, opacity: 0.8, color: "#ffffff" };
  const frame = {
    ...buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, ...size }),
    style: { paints: [radial, other] },
  };
  const before = parseDesignDocument({
    ...blankDesignDocument(),
    tokens: { brand: "#00ff00" },
    nodes: [frame],
  });
  const after = editGradientDocument(
    before,
    "frame",
    "paint",
    { kind: "radial", rotation: 45 },
    size,
  );
  expect(after.nodes[0].style.paints[0]).toMatchObject({
    rotation: 45,
    stops: [{ token: "brand" }, {}],
  });
  expect(after.nodes[0].style.paints[1]).toEqual(other);
  const patch = diffDocument(before, after);
  expect(applyDocumentPatch(before, patch)).toEqual(after);
  expect(applyDocumentPatch(after, invertPatch(patch))).toEqual(before);
  const captured = webCaptureSchema.parse({
    title: "Gradient",
    url: "https://example.com/",
    mode: "element",
    document: after,
    assets: [],
  });
  expect(parseDesignDocument(JSON.parse(JSON.stringify(captured.document)))).toEqual(after);
  for (const rotation of [NaN, Infinity, 361, -361])
    expect(
      designNodeChangesSchema.safeParse({ style: { paints: [{ ...radial, rotation }] } }).success,
    ).toBe(false);
});
