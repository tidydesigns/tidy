import { expect, test } from "bun:test";
import {
  layoutPresences,
  placePresence,
  presenceDetailsLayout,
  type PresenceBox,
} from "./agent-presence-layout";

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

test("details remain usable at the top of a short canvas", () => {
  const details = presenceDetailsLayout(20, 24, { width: 400, height: 200 });
  expect(details.above).toBe(false);
  expect(details.maxHeight).toBe(132);
});

test("details use the space above near the bottom, and stay inside narrow canvases", () => {
  const details = presenceDetailsLayout(96, 160, { width: 180, height: 200 });
  expect(details.above).toBe(true);
  expect(details.maxHeight).toBe(140);
  expect(details.width).toBe(156);
  expect(96 + details.left).toBe(12);
});

test("a layer cursor cannot cover the unplaced teammate at the canvas margin", () => {
  const targets = [
    { key: "editing", width: 72, focus: { left: 0, top: 58, width: 92, height: 40 } },
    { key: "preparing", width: 72 },
  ];
  const { placements, margin } = layoutPresences(targets, { width: 800, height: 600 }, true);
  const cursor = placements.get("editing")!;
  expect(cursor).toBeDefined();
  expect(margin).toBeDefined();
  expect(
    cursor.left >= margin!.left + margin!.width || cursor.top >= margin!.top + margin!.height,
  ).toBe(true);
  const alone = layoutPresences(targets.slice(0, 1), { width: 800, height: 600 }, true);
  expect(alone.margin).toBeUndefined();
  expect(alone.placements.get("editing")?.left).toBe(20);
});
