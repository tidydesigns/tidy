import type { Terminal } from "ghostty-web";

/** Keep ghostty-web's presentation loop, but avoid scanning/painting an unchanged viewport. */
class TerminalPaintState {
  private previous: readonly unknown[] = [];
  private invalidated = true;
  invalidate() {
    this.invalidated = true;
  }
  changed(state: readonly unknown[], dirty: boolean, force: boolean) {
    const changed =
      force ||
      dirty ||
      this.invalidated ||
      state.some((value, index) => value !== this.previous[index]);
    if (changed) {
      this.previous = state;
      this.invalidated = false;
    }
    return changed;
  }
}

export function installTerminalRendering(terminal: Terminal) {
  const state = new TerminalPaintState();
  let active = true;
  const open = terminal.open.bind(terminal);
  terminal.open = (element) => {
    open(element);
    const renderer = terminal.renderer!;
    const paint = renderer.render.bind(renderer);
    // Hover and cursor styling are presentation changes, not WASM dirty rows.
    const hoverId = renderer.setHoveredHyperlinkId.bind(renderer);
    renderer.setHoveredHyperlinkId = (id) => {
      state.invalidate();
      hoverId(id);
    };
    const hoverRange = renderer.setHoveredLinkRange.bind(renderer);
    renderer.setHoveredLinkRange = (range) => {
      state.invalidate();
      hoverRange(range);
    };
    const cursorStyle = renderer.setCursorStyle.bind(renderer);
    renderer.setCursorStyle = (style) => {
      state.invalidate();
      cursorStyle(style);
    };
    renderer.render = (buffer, force = false, viewportY = 0, scrollback, opacity = 1) => {
      if (!active) return;
      const native = terminal.wasmTerm;
      if (!native || buffer !== native) return paint(buffer, force, viewportY, scrollback, opacity);
      const dirty = native.isDirty();
      const cursor = native.getCursor();
      const dimensions = native.getDimensions();
      // Selection can move during a drag before onSelectionChange fires.
      const selection = terminal.getSelectionPosition();
      const canvas = renderer.getCanvas();
      if (
        !state.changed(
          [
            native,
            dimensions.cols,
            dimensions.rows,
            cursor.x,
            cursor.y,
            cursor.visible,
            viewportY,
            opacity,
            scrollback?.getScrollbackLength(),
            canvas.width,
            canvas.height,
            selection?.start.x,
            selection?.start.y,
            selection?.end.x,
            selection?.end.y,
          ],
          dirty,
          force || terminal.options.cursorBlink,
        )
      )
        return;
      let viewport: ReturnType<typeof native.getViewport> | undefined;
      // getLine otherwise decodes the entire viewport for every row. Preserve
      // copies: WASM's cell pool is mutable and also used by selection/link reads.
      const frame: Parameters<typeof paint>[0] = {
        getCursor: () => cursor,
        getDimensions: () => dimensions,
        isRowDirty: (row) => native.isRowDirty(row),
        needsFullRedraw: () => native.needsFullRedraw(),
        clearDirty: () => native.clearDirty(),
        getGraphemeString: (row, col) => native.getGraphemeString(row, col),
        getLine(row) {
          if (row < 0 || row >= dimensions.rows) return null;
          viewport ??= native.getViewport();
          return viewport
            .slice(row * dimensions.cols, (row + 1) * dimensions.cols)
            .map((cell) => ({ ...cell }));
        },
      };
      return paint(frame, force, viewportY, scrollback, opacity);
    };
  };
  return {
    setActive(value: boolean) {
      if (active !== value) state.invalidate();
      active = value;
    },
  };
}
