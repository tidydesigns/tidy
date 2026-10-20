import type { CanvasView } from "../design/canvas-culling";
import type { SnapGuide, SpacingCue } from "../design/snapping";

export function CanvasAlignment({
  guides,
  spacing,
  view,
}: {
  guides: SnapGuide[];
  spacing: SpacingCue[];
  view: CanvasView;
}) {
  if (!guides.length && !spacing.length) return null;
  const screen = (value: number, axis: "x" | "y") => Math.round(value * view.zoom + view[axis]);
  return (
    <div
      data-canvas-alignment
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-[12] overflow-hidden"
    >
      {guides.map((guide) => {
        const cross = guide.axis === "x" ? "y" : "x";
        const position = screen(guide.position, guide.axis);
        const start = screen(guide.start, cross);
        const length = screen(guide.end, cross) - start;
        return (
          <div
            key={guide.axis}
            data-snap-guide={guide.axis}
            className="absolute bg-primary-orange"
            style={
              guide.axis === "x"
                ? { left: position, top: start, width: 1, height: length }
                : { top: position, left: start, height: 1, width: length }
            }
          />
        );
      })}
      {spacing.map((cue, index) => {
        const cross = cue.axis === "x" ? "y" : "x";
        const start = screen(cue.start, cue.axis);
        const length = screen(cue.end, cue.axis) - start;
        const position = screen(cue.cross, cross);
        return (
          <div
            key={`${cue.axis}-${index}`}
            data-spacing-cue={cue.axis}
            className="absolute bg-primary-orange"
            style={
              cue.axis === "x"
                ? { left: start, top: position, width: length, height: 1 }
                : { top: start, left: position, height: length, width: 1 }
            }
          >
            {length >= 28 && (
              <span className="absolute -top-5 left-1/2 -translate-x-1/2 rounded bg-primary-orange px-1 text-[10px] leading-4 text-on-brand">
                {Math.round(cue.gap * 10) / 10}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
