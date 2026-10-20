import { expect, test } from "bun:test";
import { hexToHsva, hsvaToHex } from "../../../../packages/editor/src/editor/color-values";

test("sRGB colours round-trip through picker coordinates without losing alpha", () => {
  for (const color of [
    "#000000",
    "#ffffff",
    "#ff0000",
    "#00ff00",
    "#0000ff",
    "#224466",
    "#ff5d0080",
    "#abcdef00",
  ]) {
    expect(hsvaToHex(hexToHsva(color))).toBe(color);
  }
});

test("hue, saturation, brightness and opacity define independent colour changes", () => {
  expect(hsvaToHex({ h: 120, s: 1, v: 1, a: 1 })).toBe("#00ff00");
  expect(hsvaToHex({ h: 240, s: 1, v: 0.5, a: 0.5 })).toBe("#00008080");
  expect(hsvaToHex({ h: 280, s: 0, v: 1, a: 0 })).toBe("#ffffff00");
  expect(hexToHsva("#808080").s).toBe(0);
  expect(hexToHsva("#000000").v).toBe(0);
});
