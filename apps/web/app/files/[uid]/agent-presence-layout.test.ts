import { expect, test } from "bun:test";
import { placePresence, type PresenceBox } from "./agent-presence-layout";

test("three teammates at the same target have separate, bounded identities", () => {
  const viewport = { width: 1000, height: 700 };
  const target = { left: 500, top: 300, width: 200, height: 100 };
  const placed: PresenceBox[] = [];
  for (let i = 0; i < 3; i++) {
    const box = placePresence(target, viewport, placed)!;
    expect(box).toBeDefined();
    expect(box.left).toBeGreaterThanOrEqual(12);
    expect(box.left + box.width).toBeLessThanOrEqual(viewport.width - 12);
    for (const other of placed)
      expect(
        box.left >= other.left + other.width ||
          box.left + box.width <= other.left ||
          box.top >= other.top + other.height ||
          box.top + box.height <= other.top,
      ).toBe(true);
    placed.push(box);
  }
});

test("partly offscreen targets and narrow viewports keep the identity inside", () => {
  const box = placePresence(
    { left: -300, top: -50, width: 900, height: 500 },
    { width: 180, height: 400 },
    [],
  )!;
  expect(box.left).toBe(12);
  expect(box.top).toBe(12);
  expect(box.width).toBe(156);
});

test("an overcrowded viewport falls back to the edge group", () => {
  expect(
    placePresence({ left: 0, top: 0, width: 100, height: 100 }, { width: 200, height: 160 }, [
      { left: 0, top: 0, width: 200, height: 160 },
    ]),
  ).toBeUndefined();
});
