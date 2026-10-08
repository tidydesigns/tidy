import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

function themeColors(name) {
  const match = css.match(
    new RegExp(
      `--color-${name}: (?:light-dark\\((#[0-9a-f]{6}), (#[0-9a-f]{6})\\)|(#[0-9a-f]{6}));`,
      "i",
    ),
  );
  if (!match) throw new Error(`Missing light and dark values for ${name}`);
  return match[3] ? [match[3], match[3]] : match.slice(1, 3);
}

function luminance(hex) {
  const channels = [1, 3, 5]
    .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(first, second) {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test("neutral text meets WCAG AA contrast on app surfaces in both themes", () => {
  for (const ink of ["ink", "secondary-ink", "muted-ink", "accent-ink"]) {
    for (const surface of ["panel", "surface", "canvas"]) {
      for (const themeIndex of [0, 1]) {
        const ratio = contrast(themeColors(ink)[themeIndex], themeColors(surface)[themeIndex]);
        expect(
          ratio,
          `${ink} on ${surface} in ${themeIndex === 0 ? "light" : "dark"} mode`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

test("neutral action labels remain readable in both themes", () => {
  for (const [ink, surface] of [
    ["on-accent", "accent"],
    ["on-strong-action", "strong-action"],
    ["on-strong-action", "strong-action-hover"],
    ["ink", "surface"],
    ["ink", "hover-surface"],
    ["ink", "pressed-surface"],
  ]) {
    for (const themeIndex of [0, 1]) {
      expect(
        contrast(themeColors(ink)[themeIndex], themeColors(surface)[themeIndex]),
        `${ink} on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
});
