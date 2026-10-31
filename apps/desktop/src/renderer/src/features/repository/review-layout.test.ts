import { expect, test } from "bun:test";
import type { CodeRow } from "./file-rows";
import {
  offsetIndex,
  reviewOffsets,
  reviewRange,
  reviewRowOffsets,
  reviewRowLayout,
} from "./review-layout";

test("finds file boundaries and keeps the window bounded by pixels across a huge diff", () => {
  const offsets = reviewOffsets([112, 480000, 112, 112]);
  expect(offsetIndex(offsets, 112)).toBe(1);
  expect(reviewRange(offsets, 20000, 600)).toEqual({ start: 1, end: 2 });
  expect(reviewRange(offsets, 480100, 600, 0)).toEqual({ start: 1, end: 4 });
  expect(reviewRange(reviewOffsets([]), 0, 600)).toEqual({ start: 0, end: 0 });
  expect(offsetIndex(offsets, Number.MAX_SAFE_INTEGER)).toBe(3);
});

test("wrapped split rows use the taller side and accept measured heights", () => {
  const rows: CodeRow[] = [
    {
      kind: "lines",
      changed: true,
      before: { number: 1, text: "x".repeat(100) },
      after: { number: 1, text: "short" },
    },
    { kind: "hunk", before: 1, after: 1 },
  ];
  const split = reviewRowOffsets(rows, 600, true, true, new Map());
  const single = reviewRowOffsets(rows, 600, false, true, new Map());
  expect(split[1]).toBeGreaterThan(single[1]);
  expect(split[2] - split[1]).toBe(24);
  expect(reviewRowOffsets(rows, 600, true, true, new Map([[0, 144]]))[1]).toBe(144);
  expect([...reviewRowOffsets(rows, 600, true, false, new Map([[0, 144]]))]).toEqual([0, 24, 48]);
});

test("row windows include the visible row without mounting every row in a large file", () => {
  const offsets = reviewOffsets(Array.from({ length: 20000 }, () => 24));
  const range = reviewRange(offsets, 240000, 480);
  expect(range.start).toBe(9992);
  expect(range.end - range.start).toBeLessThan(40);
  const longRows = reviewOffsets(Array.from({ length: 20000 }, () => 2400));
  const longRange = reviewRange(longRows, 240000, 480);
  expect(longRange.end - longRange.start).toBeLessThan(4);
});

test("large wrapped previews retain every row within safe scroll geometry", () => {
  const rows: CodeRow[] = Array.from({ length: 20000 }, (_, index) => ({
    kind: "lines",
    changed: true,
    before: { number: index + 1, text: "x".repeat(100) },
    after: { number: index + 1, text: "y".repeat(100) },
  }));
  const layout = reviewRowLayout(rows, 320, true, true, new Map());
  expect(layout.wrap).toBe(true);
  expect(layout.limited).toBe(false);
  expect(layout.offsets.length).toBe(20001);
  expect(layout.offsets[20000]).toBeGreaterThan(480000);
  expect(reviewRange(layout.offsets, layout.offsets[20000] - 100, 600, 0).end).toBe(20000);
});

test("extreme wrapped previews stay within scroll limits without forcing horizontal scrolling", () => {
  const rows: CodeRow[] = Array.from({ length: 20000 }, (_, index) => ({
    kind: "lines",
    changed: true,
    before: null,
    after: { number: index + 1, text: "x".repeat(4000) },
  }));
  const layout = reviewRowLayout(rows, 320, true, true, new Map());
  expect(layout.wrap).toBe(true);
  expect(layout.limited).toBe(true);
  expect(layout.offsets[layout.offsets.length - 1]).toBeLessThanOrEqual(8000000);
  expect(layout.offsets.length).toBeGreaterThan(1);
  const unwrapped = reviewRowLayout(rows, 320, true, false, new Map());
  expect(unwrapped.limited).toBe(false);
  expect(unwrapped.offsets.length).toBe(20001);
});
