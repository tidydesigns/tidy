import type { CodeRow } from "./file-rows";

export const reviewHeaderHeight = 32;
export const reviewBodyOffset = reviewHeaderHeight;
export const reviewPlaceholderHeight = 120;

export function offsetIndex(offsets: ArrayLike<number>, top: number) {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= top) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function reviewOffsets(heights: readonly number[]) {
  const offsets = new Float64Array(heights.length + 1);
  heights.forEach((height, index) => {
    offsets[index + 1] = offsets[index] + Math.max(0, height);
  });
  return offsets;
}

export function reviewRange(
  offsets: ArrayLike<number>,
  top: number,
  height: number,
  overscan = 192,
) {
  const count = Math.max(0, offsets.length - 1);
  if (!count) return { start: 0, end: 0 };
  return {
    start: offsetIndex(offsets, Math.max(0, top - overscan)),
    end: Math.min(count, offsetIndex(offsets, top + Math.max(0, height) + overscan) + 1),
  };
}

export function reviewRowOffsets(
  rows: readonly CodeRow[],
  width: number,
  split: boolean,
  wrap: boolean,
  measured: ReadonlyMap<number, number>,
) {
  const characters = Math.max(1, Math.floor((width / (split ? 2 : 1) - 100) / 8));
  return reviewOffsets(
    rows.map((row, index) => {
      if (!wrap) return 24;
      const height = measured.get(index);
      if (height !== undefined) return height;
      if (!width || row.kind !== "lines") return 24;
      const length = Math.max(
        row.before?.text.replace(/\t/g, "    ").length ?? 0,
        row.after?.text.replace(/\t/g, "    ").length ?? 0,
      );
      return 24 * Math.max(1, Math.ceil(length / characters));
    }),
  );
}

export function reviewRowLayout(
  rows: readonly CodeRow[],
  width: number,
  split: boolean,
  wrap: boolean,
  measured: ReadonlyMap<number, number>,
) {
  const offsets = reviewRowOffsets(rows, width, split, wrap, measured);
  const limit = 8000000;
  const limited = wrap && offsets[offsets.length - 1] > limit;
  return {
    offsets: limited ? offsets.slice(0, offsetIndex(offsets, limit) + 1) : offsets,
    wrap,
    limited,
  };
}
