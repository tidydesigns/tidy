import { expect, test } from "bun:test";
import { resolveComposerControlsLayout } from "./controls-layout";

const controls = [
  { natural: 32, compact: 32 },
  { natural: 170, compact: 96, priority: 0 },
  { natural: 90, compact: 32, priority: 1 },
  { natural: 150, compact: 32, priority: 2 },
];
const fit = (available: number, previous = 0) =>
  resolveComposerControlsLayout({ available, controls, gap: 8, previous });

test("fits actual control widths and progressively removes trailing labels", () => {
  expect(fit(466)).toEqual({ compactCount: 0, overflow: false });
  expect(fit(465)).toEqual({ compactCount: 1, overflow: false });
  expect(fit(347)).toEqual({ compactCount: 2, overflow: false });
  expect(fit(289)).toEqual({ compactCount: 3, overflow: false });
  expect(fit(216)).toEqual({ compactCount: 3, overflow: false });
});

test("restores labels only after enough slack, without oscillating at fractional widths", () => {
  expect(fit(466, 1).compactCount).toBe(1);
  expect(fit(467, 1).compactCount).toBe(0);
  expect(fit(466.5, 1).compactCount).toBe(1);
  expect(fit(465.5, 0).compactCount).toBe(1);
  expect(fit(348, 2).compactCount).toBe(2);
  expect(fit(349, 2).compactCount).toBe(1);
});

test("only overflows when every existing setting has reached its icon width", () => {
  expect(fit(215)).toEqual({ compactCount: 3, overflow: true });
  expect(fit(0)).toEqual({ compactCount: 3, overflow: true });
  expect(fit(800, 3)).toEqual({ compactCount: 0, overflow: false });
});

test("handles models without effort controls and changing label widths", () => {
  expect(
    resolveComposerControlsLayout({
      available: 240,
      controls: [controls[0]!, controls[1]!, { ...controls[3]!, priority: 1 }],
      gap: 8,
    }),
  ).toEqual({ compactCount: 2, overflow: false });
  expect(
    resolveComposerControlsLayout({
      available: 500,
      controls: controls.map((control) => ({ ...control, natural: control.natural * 1.5 })),
      gap: 8,
    }).compactCount,
  ).toBe(1);
  expect(resolveComposerControlsLayout({ available: 0, controls: [], gap: 8 })).toEqual({
    compactCount: 0,
    overflow: false,
  });
});
