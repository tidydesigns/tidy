import type { Terminal } from "ghostty-web";

export function installTerminalRendering(terminal: Terminal) {
  let previous: readonly unknown[] = [];
  let invalidated = true;
  let active = true;
  const open = terminal.open.bind(terminal);
  terminal.open = (element) => {
    open(element);
    const renderer = terminal.renderer!;
    const paint = renderer.render.bind(renderer);
    // Hover and cursor styling are presentation changes, not WASM dirty rows.
    const hoverId = renderer.setHoveredHyperlinkId.bind(renderer);
    renderer.setHoveredHyperlinkId = (id) => {
      invalidated = true;
      hoverId(id);
    };
    const hoverRange = renderer.setHoveredLinkRange.bind(renderer);
    renderer.setHoveredLinkRange = (range) => {
      invalidated = true;
      hoverRange(range);
    };
    const cursorStyle = renderer.setCursorStyle.bind(renderer);
    renderer.setCursorStyle = (style) => {
      invalidated = true;
      cursorStyle(style);
    };
    renderer.render = (buffer, force = false, viewportY = 0, scrollback, opacity = 1) => {
      if (!active) return;
      const native = terminal.wasmTerm;
      if (!native || buffer !== native) return paint(buffer, force, viewportY, scrollback, opacity);
      viewportY = Math.floor(viewportY);
      const dirty = native.isDirty();
      const cursor = native.getCursor();
      const dimensions = native.getDimensions();
      // Selection can move during a drag before onSelectionChange fires.
      const selection = terminal.getSelectionPosition();
      const canvas = renderer.getCanvas();
      const scrollbackLength = scrollback?.getScrollbackLength() ?? 0;
      const next = [
        native,
        dimensions.cols,
        dimensions.rows,
        cursor.x,
        cursor.y,
        cursor.visible,
        viewportY,
        opacity,
        scrollbackLength,
        canvas.width,
        canvas.height,
        selection?.start.x,
        selection?.start.y,
        selection?.end.x,
        selection?.end.y,
      ];
      if (
        !force &&
        !terminal.options.cursorBlink &&
        !dirty &&
        !invalidated &&
        next.every((value, index) => value === previous[index])
      )
        return;
      previous = next;
      invalidated = false;
      let viewport: ReturnType<typeof native.getViewport> | undefined;
      // Read once per synchronous paint. CanvasRenderer consumes each row
      // immediately, so it does not need a copied object for every pooled cell.
      const frame: Parameters<typeof paint>[0] = {
        getCursor: () => cursor,
        getDimensions: () => dimensions,
        isRowDirty: (row) => native.isRowDirty(row),
        needsFullRedraw: () => native.needsFullRedraw(),
        clearDirty: () => native.clearDirty(),
        getGraphemeString: (row, col) =>
          row < viewportY
            ? native.getScrollbackGraphemeString(scrollbackLength - viewportY + row, col)
            : native.getGraphemeString(row - viewportY, col),
        getLine(row) {
          if (row < 0 || row >= dimensions.rows) return null;
          viewport ??= native.getViewport();
          return viewport.slice(row * dimensions.cols, (row + 1) * dimensions.cols);
        },
      };
      return paint(frame, force, viewportY, scrollback, opacity);
    };
  };
  return {
    setActive(value: boolean) {
      if (active !== value) invalidated = true;
      active = value;
    },
  };
}
