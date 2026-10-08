import { expect, test } from "bun:test";
import { nearestSnapAnchor } from "./snap-index";
import { snapTranslation, type SnapBox } from "./snapping";

test("indexed snapping preserves closest-distance and original-order ties", () => {
  let seed = 37;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const candidates: SnapBox[] = Array.from({ length: 500 }, () => ({
    x: Math.floor(random() * 300),
    y: Math.floor(random() * 300),
    width: Math.floor(random() * 30) + 1,
    height: Math.floor(random() * 30) + 1,
  }));
  for (let trial = 0; trial < 200; trial++)
    for (const axis of ["x", "y"] as const) {
      const value = Math.floor(random() * 300),
        tolerance = 6;
      const size = axis === "x" ? "width" : "height";
      let best: { distance: number; candidate: SnapBox; rank: number } | undefined;
      candidates.forEach((candidate, index) =>
        [0, 0.5, 1].forEach((anchor, offset) => {
          const distance = candidate[axis] + candidate[size] * anchor - value;
          if (
            Math.abs(distance) <= tolerance &&
            (!best || Math.abs(distance) < Math.abs(best.distance))
          )
            best = { distance, candidate, rank: index * 3 + offset };
        }),
      );
      const found = nearestSnapAnchor(candidates, axis, value, tolerance);
      expect(found?.distance).toBe(best?.distance);
      expect(found?.candidate).toBe(best?.candidate);
      expect(found?.rank).toBe(best?.rank);
    }
  const source = { x: 0, y: 0, width: 20, height: 20 };
  const targets = [
    { x: 25, y: 0, width: 20, height: 20 },
    ...Array.from({ length: 128 }, () => ({ x: 10000, y: 10000, width: 10, height: 10 })),
  ];
  expect(snapTranslation(source, { x: 23, y: 0 }, targets, 3)).toEqual(
    snapTranslation(source, { x: 23, y: 0 }, targets.slice(0, 1), 3),
  );
});
