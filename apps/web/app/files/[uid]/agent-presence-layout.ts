export type PresenceBox = { left: number; top: number; width: number; height: number };

/** Prefer below the identity when it fits; otherwise use the roomier side.
 * A fixed distance from the bottom can choose an unusable sliver in short canvases. */
export function presenceDetailsLayout(
  x: number,
  y: number,
  viewport: { width: number; height: number },
) {
  const width = Math.max(0, Math.min(288, viewport.width - 24));
  const aboveSpace = Math.max(0, y - 20);
  const belowSpace = Math.max(0, viewport.height - y - 44);
  const above = belowSpace < Math.min(240, aboveSpace);
  return {
    above,
    width,
    left: Math.min(0, viewport.width - x - width - 12),
    maxHeight: Math.min(240, above ? aboveSpace : belowSpace),
  };
}

/** Keep identities readable when collaborators touch the same layer. If a
 * viewport cannot fit another identity, it belongs in the compact edge group. */
export function placePresence(
  target: PresenceBox,
  viewport: { width: number; height: number },
  occupied: PresenceBox[],
  preferredWidth = 160,
): PresenceBox | undefined {
  const width = Math.max(0, Math.min(preferredWidth, viewport.width - 24));
  const left = target.left + target.width - width;
  const top = target.top - 34;
  for (const [dx, dy] of [
    [0, 0],
    [width + 12, 0],
    [-width - 12, 0],
    [0, -38],
    [0, target.height + 42],
  ]) {
    const box = {
      left: Math.max(12, Math.min(left + dx, viewport.width - width - 12)),
      top: Math.max(12, Math.min(top + dy, viewport.height - 40)),
      width,
      height: 24,
    };
    if (
      !occupied.some(
        (other) =>
          box.left < other.left + other.width + 8 &&
          box.left + box.width + 8 > other.left &&
          box.top < other.top + other.height + 12 &&
          box.top + box.height + 12 > other.top,
      )
    )
      return box;
  }
}

/** Reserve the margin only when there is unplaced work. All identities then
 * participate in the same collision layout, including the overflow group. */
export function layoutPresences(
  targets: { key: string; width: number; focus?: PresenceBox }[],
  viewport: { width: number; height: number },
  panelsOpen: boolean,
) {
  const placements = new Map<string, PresenceBox>();
  const placeTargets = (reserved?: PresenceBox) => {
    placements.clear();
    for (const target of targets) {
      if (!target.focus || placements.size >= 3) continue;
      const box = placePresence(
        target.focus,
        viewport,
        [...(reserved ? [reserved] : []), ...placements.values()],
        target.width,
      );
      if (box) placements.set(target.key, box);
    }
  };
  placeTargets();
  if (placements.size === targets.length) return { placements, margin: undefined };
  // Reserve enough for any unplaced identity plus the collapsed agent count.
  const width = Math.max(
    0,
    Math.min(Math.max(...targets.map((item) => item.width)) + 24, viewport.width - 24),
  );
  const margin = {
    left: Math.max(12, Math.min(panelsOpen ? 20 : 72, viewport.width - width - 12)),
    top: Math.max(12, Math.min(panelsOpen ? 24 : 80, viewport.height - 48)),
    width,
    height: 24,
  };
  placeTargets(margin);
  return { placements, margin };
}
