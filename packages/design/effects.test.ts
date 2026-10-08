import { expect, test } from "bun:test";
import { designNodeChangesSchema } from "./document";
import {
  effectCss,
  effectStyle,
  moveEffect,
  nodeEffects,
  nodeShadows,
  parseCssShadows,
  shadowCss,
  shadowStyle,
} from "./effects";
import { captureStyle } from "./browser-capture";

test("legacy filters promote in their original order; explicit empty stacks disable them", () => {
  const style = {
    blur: 3,
    brightness: 120,
    contrast: 80,
    grayscale: 0,
    saturation: 60,
    hueRotate: 25,
  };
  expect(effectCss(style)).toBe(
    "blur(3px) brightness(120%) contrast(80%) saturate(60%) hue-rotate(25deg)",
  );
  const effects = nodeEffects(style);
  const converted = { ...style, ...effectStyle(effects) };
  expect(effectCss(converted)).toBe(effectCss(style));
  expect(converted.blur).toBeUndefined();
  expect(effectCss({ ...style, effects: [] })).toBeUndefined();
  expect(designNodeChangesSchema.safeParse({ style: converted }).success).toBe(true);
});
test("effect visibility and reordering preserve identities and latest amounts", () => {
  const effects = nodeEffects({ contrast: 80, brightness: 150 });
  const latest = effects.map((effect) =>
    effect.type === "brightness" ? { ...effect, amount: 125 } : effect,
  );
  const moved = moveEffect(latest, "legacy-contrast", -1);
  expect(effectCss({ effects: moved })).toBe("contrast(80%) brightness(125%)");
  expect(
    effectCss({
      effects: moved.map((effect) => ({ ...effect, visible: effect.type !== "contrast" })),
    }),
  ).toBe("brightness(125%)");
  expect(moveEffect(latest, "removed", 1)).toBe(latest);
  expect(moveEffect(latest, latest[0]!.id, -1)).toBe(latest);
});
test("effect and shadow identities, ranges, and counts are validated", () => {
  for (const effect of [
    { type: "blur", amount: 101 },
    { type: "grayscale", amount: -1 },
    { type: "brightness", amount: 201 },
    { type: "hueRotate", amount: Infinity },
  ])
    expect(
      designNodeChangesSchema.safeParse({
        style: { effects: [{ id: "effect", visible: true, ...effect }] },
      }).success,
    ).toBe(false);
  const effect = { id: "effect", type: "blur", amount: 2, visible: true };
  expect(designNodeChangesSchema.safeParse({ style: { effects: [effect, effect] } }).success).toBe(
    false,
  );
  expect(
    designNodeChangesSchema.safeParse({
      style: {
        effects: Array.from({ length: 21 }, (_, index) => ({ ...effect, id: String(index) })),
      },
    }).success,
  ).toBe(false);
  const shadow = parseCssShadows("0 2px 8px #00000033")![0]!;
  expect(designNodeChangesSchema.safeParse({ style: { shadows: [shadow, shadow] } }).success).toBe(
    false,
  );
});
test("CSS shadows parse inset, spread, transparent colors and multiple functions without losing order", () => {
  const source = "rgba(10, 20, 30, 0.5) 1px -2px 8px 3px, inset 0 0 4px #f008";
  const shadows = parseCssShadows(source)!;
  expect(shadows).toMatchObject([
    { x: 1, y: -2, blur: 8, spread: 3, color: "#0a141e80", inset: false },
    { x: 0, y: 0, blur: 4, spread: 0, color: "#ff000088", inset: true },
  ]);
  expect(parseCssShadows("0 0 transparent")![0]!.color).toBe("#00000000");
  expect(parseCssShadows("2px 3px", "imported", "#123456")![0]!.color).toBe("#123456");
  for (const invalid of [
    "0 0 -4px red",
    "url(x) 0 0",
    "1em 0 red",
    "0 0 var(--shadow)",
    "0 0 2px red, broken",
  ])
    expect(parseCssShadows(invalid)).toBeUndefined();
  expect(shadowCss({ shadow: source })).toBe(source);
});
test("shadow parsing rejects malformed grouping and empty shadows without salvaging fragments", () => {
  for (const source of [
    "(0 0 red",
    "0 0 red)",
    "0 0 rgb((1),2,3)",
    ",0 0 red",
    "0 0 red,",
    "0 0 red,,0 0 blue",
    "(".repeat(20_000) + "0 0 red",
  ]) {
    expect(parseCssShadows(source)).toBeUndefined();
    expect(shadowStyle({ shadow: source }, []).shadow).toBe(source);
  }
});
test("computed shadows support the full stack while bounding parser and color input", () => {
  const shadow = "rgb(10, 20, 30) 1px 2px 3px";
  expect(parseCssShadows(Array(20).fill(shadow).join(", "))).toHaveLength(20);
  expect(parseCssShadows(Array(21).fill(shadow).join(", "))).toBeUndefined();
  expect(parseCssShadows("0 0 red".padEnd(4096))).toHaveLength(1);
  expect(parseCssShadows("0 0 red".padEnd(4097))).toBeUndefined();
  expect(parseCssShadows(`0 0 rgb(1,2,${" ".repeat(128)}3)`)).toBeUndefined();
  expect(parseCssShadows("0\t0\nrgba(100% 0% 0% / 25%)")![0]!.color).toBe("#ff000040");
});
test("editing promotes imported shadows and retains unsupported raw CSS and colliding identities", () => {
  const style = {
    shadow: "0 3px 6px black",
    innerShadow: "0 0 2px rgba(0,0,0,0.5)",
    shadows: [
      {
        id: "imported-outer-0",
        x: 2,
        y: 2,
        blur: 1,
        spread: 0,
        color: "#ffffff",
        inset: false,
        visible: true,
      },
    ],
  };
  const converted = shadowStyle(style, nodeShadows(style));
  expect(converted.shadow).toBeUndefined();
  expect(converted.innerShadow).toBeUndefined();
  expect(new Set(converted.shadows!.map((shadow) => shadow.id)).size).toBe(3);
  expect(designNodeChangesSchema.safeParse({ style: converted }).success).toBe(true);
  expect(nodeShadows(converted)).toEqual(converted.shadows as ReturnType<typeof nodeShadows>);
  const unsupported = { shadow: "0 0 var(--blur) var(--color)" };
  expect(shadowStyle(unsupported, []).shadow).toBe(unsupported.shadow);
  const full = {
    shadow: "0 3px 6px black",
    shadows: Array.from({ length: 20 }, (_, index) => ({
      ...style.shadows[0]!,
      id: String(index),
    })),
  };
  expect(nodeShadows(full)).toHaveLength(20);
  expect(shadowStyle(full, nodeShadows(full)).shadow).toBe(full.shadow);
});
test("captured shadows are structured and are not duplicated on captured text", () => {
  const css = {
    opacity: "1",
    borderTopLeftRadius: "0",
    borderTopWidth: "0",
    borderTopColor: "rgb(0,0,0)",
    backgroundColor: "transparent",
    boxShadow: "rgb(1, 2, 3) 2px 3px 4px, inset 0 0 1px #ffffff",
    color: "rgb(0, 0, 0)",
    fontSize: "16px",
    fontFamily: "Arial",
    textDecorationLine: "none",
  } as CSSStyleDeclaration;
  const captured = captureStyle(css);
  expect(captured.shadow).toBeUndefined();
  expect(captured.shadows).toHaveLength(2);
  expect(captured.shadows![1]!.inset).toBe(true);
  expect(captureStyle(css, true).shadows).toBeUndefined();
});
