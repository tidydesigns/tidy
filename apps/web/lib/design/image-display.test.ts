import { expect, test } from "bun:test";
import { displayImageUrl, imageDisplayPixels } from "@tidy/design-renderer/image-display";
test("SVG sizes share the original; rasters keep variants and large crops keep originals", () => {
  for (const source of [
    "/api/assets/id",
    "/api/github/reviews/review/assets/id",
    "/api/github/reviews/review/captures/id",
  ]) {
    for (const pixels of [108, 264])
      expect(displayImageUrl(source + "?width=512&version=one", pixels, "image/svg+xml")).toBe(
        source + "?version=one",
      );
    expect(displayImageUrl(source, 108, "image/png")).toBe(source + "?width=128");
    expect(displayImageUrl(source, 264, "image/png")).toBe(source + "?width=512");
    expect(displayImageUrl(source, 3000, "image/png")).toBe(source);
    expect(displayImageUrl(source, 108)).toBe(source);
  }
  expect(displayImageUrl("https://example.com/image.png", 108, "image/png")).toBe(
    "https://example.com/image.png",
  );
});

import { buildDrawnNode } from "./document";
const node = buildDrawnNode("image", "container", null, { x: 0, y: 0, width: 240, height: 240 });
test("display resolution follows painted dimensions and display density on both axes", () => {
  expect(imageDisplayPixels(node, 240, 240, 2, 1)).toBe(480);
  expect(imageDisplayPixels(node, 960, 960, 2, 1)).toBe(1920);
  expect(imageDisplayPixels(node, 240, 240, 2, 4)).toBe(480);
  expect(imageDisplayPixels({ ...node, style: { objectFit: "cover" } }, 240, 240, 2, 4)).toBe(1920);
  expect(imageDisplayPixels({ ...node, style: { objectFit: "fill" } }, 240, 240, 2, 4)).toBe(1920);
  expect(imageDisplayPixels({ ...node, style: { objectFit: "cover" } }, 240, 240, 2)).toBe(128);
});
test("crop resolution uses the source aspect ratio and both crop fractions", () => {
  const cropped = {
    ...node,
    style: {
      imageCrop: { x: 0, y: 0, width: 0.5, height: 0.25, sourceWidth: 2000, sourceHeight: 1000 },
    },
  };
  expect(imageDisplayPixels(cropped, 240, 240, 2)).toBe(3840);
  expect(
    displayImageUrl("/api/assets/id", imageDisplayPixels(cropped, 240, 240, 2), "image/png"),
  ).toBe("/api/assets/id");
  expect(
    imageDisplayPixels(
      { ...cropped, style: { ...cropped.style, objectFit: "contain" } },
      240,
      240,
      2,
    ),
  ).toBe(960);
});
