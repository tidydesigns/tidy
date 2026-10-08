import type { SnapBox } from "./snapping";
type Anchor = { value: number; candidate: SnapBox; rank: number };
const indexes = new WeakMap<SnapBox[], { x: Anchor[]; y: Anchor[] }>();
/** Gesture candidates are immutable; build once, then binary-search each moving anchor. */
export function prepareSnapIndex(candidates: SnapBox[]) {
  if (indexes.has(candidates)) return;
  const axis = (coordinate: "x" | "y", size: "width" | "height") =>
    candidates
      .flatMap((candidate, index) =>
        [0, 0.5, 1].map((anchor, offset) => ({
          value: candidate[coordinate] + candidate[size] * anchor,
          candidate,
          rank: index * 3 + offset,
        })),
      )
      .sort((a, b) => a.value - b.value || a.rank - b.rank);
  indexes.set(candidates, { x: axis("x", "width"), y: axis("y", "height") });
}
function lowerBound(anchors: Anchor[], value: number) {
  let lo = 0,
    hi = anchors.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (anchors[mid].value < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export function nearestSnapAnchor(
  candidates: SnapBox[],
  axis: "x" | "y",
  value: number,
  tolerance: number,
) {
  prepareSnapIndex(candidates);
  const anchors = indexes.get(candidates)![axis],
    right = lowerBound(anchors, value);
  const left = right ? lowerBound(anchors, anchors[right - 1].value) : -1;
  let best: (Anchor & { distance: number }) | undefined;
  for (const index of [left, right]) {
    const anchor = anchors[index];
    if (!anchor) continue;
    const distance = anchor.value - value;
    if (Math.abs(distance) > tolerance) continue;
    if (
      !best ||
      Math.abs(distance) < Math.abs(best.distance) ||
      (Math.abs(distance) === Math.abs(best.distance) && anchor.rank < best.rank)
    )
      best = { ...anchor, distance };
  }
  return best;
}
