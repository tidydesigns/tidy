import { nearestSnapAnchor } from "./snap-index";
export type SnapBox = { x: number; y: number; width: number; height: number };
export type SnapGuide = { axis: "x" | "y"; position: number; start: number; end: number };
const translationAnchors = [0, 0.5, 1] as const;

type TranslationSnap = {
  target: number;
  candidate: SnapBox;
  sourceAnchor: number;
  rank: number;
};
export type TranslationSnapState = Record<"x" | "y", TranslationSnap | null>;
export function createTranslationSnapState(): TranslationSnapState {
  return { x: null, y: null };
}

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

export function snapTranslation(
  box: SnapBox,
  delta: { x: number; y: number },
  candidates: SnapBox[],
  tolerance: number,
  state?: TranslationSnapState,
) {
  const matches = state ?? createTranslationSnapState();
  const result = { ...delta };
  for (const axis of ["x", "y"] as const) {
    const size = axis === "x" ? "width" : "height";
    const held = state?.[axis];
    let best: (TranslationSnap & { distance: number }) | null = null;
    if (held) {
      const distance = held.target - (box[axis] + delta[axis] + box[size] * held.sourceAnchor);
      if (Math.abs(distance) <= tolerance * 1.5) best = { ...held, distance };
    }
    if (!best && candidates.length >= 128) {
      for (let sourceIndex = 0; sourceIndex < translationAnchors.length; sourceIndex++) {
        const sourceAnchor = translationAnchors[sourceIndex];
        const found = nearestSnapAnchor(
          candidates,
          axis,
          box[axis] + delta[axis] + box[size] * sourceAnchor,
          tolerance,
        );
        if (!found) continue;
        const rank = found.rank * 3 + sourceIndex;
        if (
          !best ||
          Math.abs(found.distance) < Math.abs(best.distance) ||
          (Math.abs(found.distance) === Math.abs(best.distance) && rank < best.rank)
        )
          best = {
            distance: found.distance,
            target: found.value,
            candidate: found.candidate,
            sourceAnchor,
            rank,
          };
      }
    } else if (!best) {
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
        const candidate = candidates[candidateIndex];
        for (let targetIndex = 0; targetIndex < translationAnchors.length; targetIndex++) {
          const target = candidate[axis] + candidate[size] * translationAnchors[targetIndex];
          for (let sourceIndex = 0; sourceIndex < translationAnchors.length; sourceIndex++) {
            const sourceAnchor = translationAnchors[sourceIndex];
            const distance = target - (box[axis] + delta[axis] + box[size] * sourceAnchor);
            if (
              Math.abs(distance) > tolerance ||
              (best && Math.abs(distance) >= Math.abs(best.distance))
            )
              continue;
            best = {
              distance,
              target,
              candidate,
              sourceAnchor,
              rank: candidateIndex * 9 + targetIndex * 3 + sourceIndex,
            };
          }
        }
      }
    }
    matches[axis] = best;
    if (best) result[axis] = Math.round((result[axis] + best.distance) * 1000) / 1000;
  }
  const guides: SnapGuide[] = [];
  for (const axis of ["x", "y"] as const) {
    const match = matches[axis];
    if (!match) continue;
    const cross = axis === "x" ? "y" : "x";
    const crossSize = axis === "x" ? "height" : "width";
    guides.push({
      axis,
      position: match.target,
      start: Math.min(box[cross] + result[cross], match.candidate[cross]),
      end: Math.max(
        box[cross] + result[cross] + box[crossSize],
        match.candidate[cross] + match.candidate[crossSize],
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
