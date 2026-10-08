import { expect, test } from "bun:test";
import { displayImageUrl } from "./image-display";
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
