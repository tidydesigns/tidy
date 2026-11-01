import { expect, test } from "bun:test";
import { compactViewportTransform } from "./transition-geometry";

test("the two cameras align design points regardless of pan, zoom, panels, or titlebar", () => {
  for (const zoom of [0.01, 0.5, 1, 16]) {
    const preview = { x: -150, y: 78, zoom: 0.15 };
    const editor = { x: 600, y: -230, zoom };
    const source = { x: 948, y: 450 };
    const target = { x: 264, y: 40 };
    const compact = compactViewportTransform(preview, editor, source, target);
    for (const point of [
      { x: 0, y: 0 },
      { x: -1000, y: 300 },
      { x: 8000, y: 9000 },
    ]) {
      expect(compact.x + (target.x + editor.x + point.x * zoom) * compact.scale).toBeCloseTo(
        source.x + preview.x + point.x * preview.zoom,
      );
      expect(compact.y + (target.y + editor.y + point.y * zoom) * compact.scale).toBeCloseTo(
        source.y + preview.y + point.y * preview.zoom,
      );
    }
  }
});
