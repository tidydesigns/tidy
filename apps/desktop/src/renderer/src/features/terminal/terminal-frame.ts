/** One paint per frame, with no idle polling and no work for hidden surfaces. */
export function terminalFrame(paint: (force: boolean) => void) {
  let active = true;
  let disposed = false;
  let frame = 0;
  let force = false;
  const cancel = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const request = (full = false) => {
    force ||= full;
    if (!active || disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const full = force;
      force = false;
      paint(full);
    });
  };
  return {
    request,
    setActive(value: boolean) {
      if (active === value) return;
      active = value;
      if (active) request(true);
      else cancel();
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
