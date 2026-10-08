import { nearestSnapAnchor } from "./snap-index";
export type SnapBox = { x: number; y: number; width: number; height: number };
export type SnapGuide = { axis: "x" | "y"; position: number; start: number; end: number };
export type SpacingCue = {
  axis: "x" | "y";
  start: number;
  end: number;
  cross: number;
  gap: number;
};

export function boundingBox(boxes: SnapBox[]): SnapBox | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - y,
  };
}

/** A screen-pixel tolerance makes edge/center snapping consistent at every zoom. */
export function snapTranslation(
  box: SnapBox,
  delta: { x: number; y: number },
  candidates: SnapBox[],
  tolerance: number,
) {
  const guides: SnapGuide[] = [];
  const result = { ...delta };
  for (const axis of ["x", "y"] as const) {
    const size = axis === "x" ? "width" : "height";
    const cross = axis === "x" ? "y" : "x";
    const crossSize = axis === "x" ? "height" : "width";
    let best: { distance: number; target: number; candidate: SnapBox; rank?: number } | null = null;
    if (candidates.length >= 128)
      for (const [sourceIndex, anchor] of [0, 0.5, 1].entries()) {
        const found = nearestSnapAnchor(
          candidates,
          axis,
          box[axis] + delta[axis] + box[size] * anchor,
          tolerance,
        );
        if (!found) continue;
        const rank = found.rank * 3 + sourceIndex;
        if (
          !best ||
          Math.abs(found.distance) < Math.abs(best.distance) ||
          (Math.abs(found.distance) === Math.abs(best.distance) && rank < best.rank!)
        )
          best = {
            distance: found.distance,
            target: found.value,
            candidate: found.candidate,
            rank,
          };
      }
    else
      for (const candidate of candidates)
        for (const targetAnchor of [0, 0.5, 1])
          for (const sourceAnchor of [0, 0.5, 1]) {
            const target = candidate[axis] + candidate[size] * targetAnchor;
            const distance = target - (box[axis] + delta[axis] + box[size] * sourceAnchor);
            if (
              Math.abs(distance) > tolerance ||
              (best && Math.abs(distance) >= Math.abs(best.distance))
            )
              continue;
            best = { distance, target, candidate };
          }
    if (!best) continue;
    result[axis] = Math.round((result[axis] + best.distance) * 1000) / 1000;
    guides.push({
      axis,
      position: best.target,
      start: Math.min(box[cross] + delta[cross], best.candidate[cross]),
      end: Math.max(
        box[cross] + delta[cross] + box[crossSize],
        best.candidate[cross] + best.candidate[crossSize],
      ),
    });
  }
  return { ...result, guides };
}

/** Snap only edges moved by the resize handle, keeping the opposite edges fixed. */
export function snapResize(
  box: SnapBox,
  handle: string,
  candidates: SnapBox[],
  tolerance: number,
): SnapBox {
  const result = { ...box };
  for (const axis of ["x", "y"] as const) {
    const start = axis === "x" ? "w" : "n";
    const end = axis === "x" ? "e" : "s";
    const edge = handle.includes(start) ? "start" : handle.includes(end) ? "end" : null;
    if (!edge) continue;
    const size = axis === "x" ? "width" : "height";
    const moving = edge === "start" ? box[axis] : box[axis] + box[size];
    let correction: number | null = null;
    if (candidates.length >= 128)
      correction = nearestSnapAnchor(candidates, axis, moving, tolerance)?.distance ?? null;
    else
      for (const candidate of candidates)
        for (const anchor of [0, 0.5, 1]) {
          const delta = candidate[axis] + candidate[size] * anchor - moving;
          if (
            Math.abs(delta) <= tolerance &&
            (correction === null || Math.abs(delta) < Math.abs(correction))
          )
            correction = delta;
        }
    if (correction === null) continue;
    if (edge === "start" && box[size] - correction >= 1) {
      result[axis] += correction;
      result[size] -= correction;
    }
    if (edge === "end" && box[size] + correction >= 1) result[size] += correction;
  }
  return result;
}

/** Show paired gaps only when adjacent objects are evenly spaced on the cross axis. */
export function equalSpacingCues(
  box: SnapBox,
  delta: { x: number; y: number },
  candidates: SnapBox[],
  tolerance: number,
): SpacingCue[] {
  const moved = { ...box, x: box.x + delta.x, y: box.y + delta.y };
  const cues: SpacingCue[] = [];
  for (const axis of ["x", "y"] as const) {
    const size = axis === "x" ? "width" : "height";
    const cross = axis === "x" ? "y" : "x";
    const crossSize = axis === "x" ? "height" : "width";
    let before: SnapBox | undefined, after: SnapBox | undefined;
    for (const candidate of candidates) {
      if (
        candidate[cross] >= moved[cross] + moved[crossSize] ||
        candidate[cross] + candidate[crossSize] <= moved[cross]
      )
        continue;
      if (
        candidate[axis] + candidate[size] <= moved[axis] &&
        (!before || candidate[axis] + candidate[size] > before[axis] + before[size])
      )
        before = candidate;
      if (candidate[axis] >= moved[axis] + moved[size] && (!after || candidate[axis] < after[axis]))
        after = candidate;
    }
    if (!before || !after) continue;
    const start = before[axis] + before[size],
      end = moved[axis] + moved[size];
    const leftGap = moved[axis] - start,
      rightGap = after[axis] - end;
    if (leftGap <= 0 || rightGap <= 0 || Math.abs(leftGap - rightGap) > tolerance) continue;
    const crossPosition = moved[cross] + moved[crossSize] / 2;
    cues.push(
      { axis, start, end: moved[axis], cross: crossPosition, gap: leftGap },
      { axis, start: end, end: after[axis], cross: crossPosition, gap: rightGap },
    );
  }
  return cues;
}
