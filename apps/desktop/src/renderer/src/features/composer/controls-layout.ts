export type ComposerControlWidth = {
  natural: number;
  compact: number;
  /** Higher priority values lose their labels first. */
  priority?: number;
};

export function resolveComposerControlsLayout({
  available,
  controls,
  gap,
  previous = 0,
}: {
  available: number;
  controls: readonly ComposerControlWidth[];
  gap: number;
  previous?: number;
}): { compactCount: number; overflow: boolean } {
  const steps = controls.filter((control) => control.priority !== undefined).length;
  const width = (count: number) =>
    Math.max(0, controls.length - 1) * gap +
    controls.reduce(
      (sum, control) =>
        sum +
        (control.priority !== undefined && control.priority >= steps - count
          ? control.compact
          : control.natural),
      0,
    );
  let compactCount = 0;
  // Restoring a label needs a pixel of slack; hiding one is immediate.
  while (
    compactCount < steps &&
    width(compactCount) > available - (compactCount < previous ? 1 : 0)
  ) {
    compactCount++;
  }
  return { compactCount, overflow: width(compactCount) > available };
}
