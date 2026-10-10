export type PresenceBox = { left: number; top: number; width: number; height: number };

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
