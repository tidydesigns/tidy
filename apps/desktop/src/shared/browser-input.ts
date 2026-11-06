import type { BrowserInputEnvelope } from "./contracts/browser";

// Keep discrete input ordered, but don't replay obsolete motion after a slow CDP call.
export function coalesceBrowserInput(
  previous: BrowserInputEnvelope,
  next: BrowserInputEnvelope,
): BrowserInputEnvelope | undefined {
  if (previous.tabId !== next.tabId || previous.viewId !== next.viewId) return;
  const a = previous.input;
  const b = next.input;
  if (a.kind === "resize" && b.kind === "resize") return next;
  if (
    a.kind === "mouse" &&
    b.kind === "mouse" &&
    a.action === "move" &&
    b.action === "move" &&
    a.buttons === b.buttons &&
    a.modifiers === b.modifiers
  )
    return next;
  if (
    a.kind === "wheel" &&
    b.kind === "wheel" &&
    a.modifiers === b.modifiers &&
    a.x === b.x &&
    a.y === b.y
  ) {
    const deltaX = a.deltaX + b.deltaX;
    const deltaY = a.deltaY + b.deltaY;
    // Preserve travel and direction changes rather than clamping away scrolling.
    if (
      Math.abs(deltaX) <= 10000 &&
      Math.abs(deltaY) <= 10000 &&
      a.deltaX * b.deltaX >= 0 &&
      a.deltaY * b.deltaY >= 0
    )
      return { ...next, input: { ...b, deltaX, deltaY } };
  }
}
