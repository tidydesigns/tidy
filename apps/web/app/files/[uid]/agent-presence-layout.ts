export type PresenceBox = { left: number; top: number; width: number; height: number };

/** Keep identities readable when collaborators touch the same layer. If a
 * viewport cannot fit another identity, it belongs in the compact edge group. */
export function placePresence(
  target: PresenceBox,
  viewport: { width: number; height: number },
  occupied: PresenceBox[],
): PresenceBox | undefined {
  const width = Math.max(0, Math.min(220, viewport.width - 24));
  const left = target.left + Math.min(target.width - 8, 64);
  const top = target.top - 64;
  for (const [dx, dy] of [
    [0, 0],
    [232, 0],
    [-232, 0],
    [0, -64],
    [0, 64],
    [232, 64],
    [-232, 64],
  ]) {
    const box = {
      left: Math.max(12, Math.min(left + dx, viewport.width - width - 12)),
      top: Math.max(12, Math.min(top + dy, viewport.height - 80)),
      width,
      height: 48,
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
