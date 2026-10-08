import { expect, test } from "bun:test";
import { captureGradient, captureGradientStack, splitCssList } from "./capture-gradients";
import { cssColor } from "./browser-capture";
import { designNodeChangesSchema } from "./document";
const size = { width: 400, height: 200 },
  color = (value: string) => cssColor(value, true);

test("computed linear gradients retain angle, hard stops, alpha and distributed stop positions", () => {
  const paint = captureGradient(
    "linear-gradient(to right, rgb(255, 0, 0) 10% 20%, rgba(0, 255, 0, 0.5), transparent 100%)",
    size,
    color,
  )!;
  expect(paint.type).toBe("linear");
  if (paint.type !== "linear") throw new Error("linear expected");
  expect(paint.angle).toBe(90);
  paint.stops.forEach((stop, index) =>
    expect(stop.position).toBeCloseTo([0.1, 0.2, 0.6, 1][index]!, 8),
  );
  expect(paint.stops.map((stop) => stop.color)).toEqual([
    "#ff0000",
    "#ff0000",
    "#00ff0080",
    "#00000000",
  ]);
  expect(designNodeChangesSchema.safeParse({ style: { paints: [paint] } }).success).toBe(true);
  const pixels = captureGradient(
    "linear-gradient(0.25turn, #ff0000 40px, #0000ff 200px)",
    size,
    color,
  )!;
  expect(pixels.type === "linear" && pixels.stops.map((stop) => stop.position)).toEqual([0.1, 0.5]);
  const corner = captureGradient("linear-gradient(to top right, #ff0000, #0000ff)", size, color)!;
  expect(corner.type === "linear" && corner.angle).toBeCloseTo(
    (Math.atan2(200, 400) * 180) / Math.PI,
    8,
  );
});

test("radial gradients retain ellipse sizing, positions and CSS default corner extent", () => {
  const explicit = captureGradient(
    "radial-gradient(ellipse 80px 20px at 25% 40%, #ff0000, #0000ff)",
    size,
    color,
  )!;
  expect(explicit).toMatchObject({
    type: "radial",
    centerX: 0.25,
    centerY: 0.4,
    radiusX: 0.2,
    radiusY: 0.1,
  });
  const defaults = captureGradient("radial-gradient(#ff0000, #0000ff)", size, color)!;
  expect(defaults).toMatchObject({ type: "radial", centerX: 0.5, centerY: 0.5 });
  if (defaults.type !== "radial") throw new Error("radial expected");
  expect(defaults.radiusX).toBeCloseTo(Math.SQRT1_2, 8);
  expect(defaults.radiusY).toBeCloseTo(Math.SQRT1_2, 8);
  const circle = captureGradient(
    "radial-gradient(circle closest-side at 25% 50%, #ff0000, #0000ff)",
    size,
    color,
  )!;
  expect(circle).toMatchObject({ type: "radial", radiusX: 0.25, radiusY: 0.5 });
});

test("complete gradient stacks retain CSS order; unsupported forms and positioning are explicit fallbacks", () => {
  const image =
    "linear-gradient(90deg, rgb(255, 0, 0), transparent), radial-gradient(ellipse at center, #ffffff, #000000)";
  expect(splitCssList(image)).toHaveLength(2);
  const paints = captureGradientStack(
    { backgroundImage: image } as CSSStyleDeclaration,
    size,
    color,
  )!;
  expect(paints.map((paint) => paint.type)).toEqual(["linear", "radial"]);
  expect(new Set(paints.map((paint) => paint.id)).size).toBe(2);
  for (const unsupported of [
    "conic-gradient(#ffffff, #000000)",
    "repeating-linear-gradient(#ffffff, #000000)",
    "linear-gradient(#ffffff -10%, #000000)",
    "linear-gradient(in oklab, #ffffff, #000000)",
    "radial-gradient(ellipse 0px 30px, #ffffff, #000000)",
  ])
    expect(captureGradient(unsupported, size, color)).toBeUndefined();
  for (const properties of [
    { backgroundAttachment: "fixed" },
    { backgroundSize: "50% 50%" },
    { backgroundPosition: "center" },
    { backgroundBlendMode: "multiply" },
    { backgroundClip: "text" },
    { backgroundImage: `${image}, url(image.png)` },
  ])
    expect(
      captureGradientStack(
        { backgroundImage: image, ...properties } as CSSStyleDeclaration,
        size,
        color,
      ),
    ).toBeUndefined();
});
