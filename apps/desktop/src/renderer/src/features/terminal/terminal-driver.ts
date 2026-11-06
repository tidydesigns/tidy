import type { Terminal } from "ghostty-web";
import { terminalFrame } from "./terminal-frame";

// Compatibility boundary for the pinned ghostty-web 0.4.0. Its permanent RAF
// loop is also the only selection/hover invalidation mechanism. Keep these
// internal hooks here and exercise them against the real package when
// upgrading; the rest of the adapter uses public methods.
type Ghostty04 = {
  startRenderLoop(): void;
  selectionManager?: { requestRender(): void };
  lastCursorY: number;
  cursorMoveEmitter: { fire(): void };
};

export function terminalDriver(terminal: Terminal) {
  const driver = terminal as unknown as Ghostty04;
  let active = true;
  let writing = false;
  let opacity = 0;
  let paintedOpacity = 0;
  let draw: (force: boolean) => void = () => {};
  const frames = terminalFrame((force) => draw(force));
  driver.startRenderLoop = () => frames.request(true);
  const visibility = () => frames.setActive(active && !document.hidden);
  const displayResize = () => frames.request(true);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("resize", displayResize);
  visibility();

  const preserveViewport = (change: () => void) => {
    const offset = terminal.viewportY;
    // The usual live-output path needs no history queries across the WASM boundary.
    const length = offset > 0 ? terminal.getScrollbackLength() : 0;
    const alternate = offset > 0 && terminal.wasmTerm?.isAlternateScreen();
    change();
    if (offset > 0 && !alternate && !terminal.wasmTerm?.isAlternateScreen()) {
      const nextLength = terminal.getScrollbackLength();
      terminal.viewportY = Math.max(0, Math.min(nextLength, offset + nextLength - length));
    } else terminal.viewportY = 0;
    frames.request();
  };
  const bottom = terminal.scrollToBottom.bind(terminal);
  terminal.scrollToBottom = () => {
    // writeInternal unconditionally follows output. Only explicit navigation
    // or user input should move a reader away from history.
    if (!writing) bottom();
  };
  const write = terminal.write.bind(terminal);
  terminal.write = (data, callback) => {
    preserveViewport(() => {
      writing = true;
      try {
        write(data, callback);
      } finally {
        writing = false;
      }
    });
  };
  const resize = terminal.resize.bind(terminal);
  terminal.resize = (cols, rows) => {
    if (cols === terminal.cols && rows === terminal.rows) return;
    preserveViewport(() => resize(cols, rows));
  };
  const clear = terminal.clear.bind(terminal);
  terminal.clear = () => {
    clear();
    frames.request(true);
  };
  const reset = terminal.reset.bind(terminal);
  terminal.reset = () => {
    reset();
    terminal.viewportY = 0;
    terminal.clearSelection();
    frames.request(true);
  };
  const scroll = terminal.onScroll(() => frames.request());
  const input = terminal.onData(() => {
    if (!writing) terminal.scrollToBottom();
  });
  const open = terminal.open.bind(terminal);
  terminal.open = (element) => {
    open(element);
    const renderer = terminal.renderer!;
    const pixels = renderer as unknown as { devicePixelRatio: number };
    const paint = renderer.render.bind(renderer);
    driver.selectionManager!.requestRender = () => frames.request();
    const hyperlink = renderer.setHoveredHyperlinkId.bind(renderer);
    let hoveredId = 0;
    renderer.setHoveredHyperlinkId = (id) => {
      if (hoveredId === id) return;
      hoveredId = id;
      hyperlink(id);
      frames.request();
    };
    const link = renderer.setHoveredLinkRange.bind(renderer);
    let hoveredRange: Parameters<typeof link>[0] = null;
    renderer.setHoveredLinkRange = (range) => {
      const previous = hoveredRange;
      if (
        previous === range ||
        (previous &&
          range &&
          previous.startX === range.startX &&
          previous.startY === range.startY &&
          previous.endX === range.endX &&
          previous.endY === range.endY)
      )
        return;
      hoveredRange = range;
      link(range);
      frames.request();
    };
    // Coalesce writes, scrollbar animation, selection, resize and hover into
    // one paint. Forced paints must preserve the last explicit fade opacity.
    renderer.render = (_buffer, force, _viewportY, _scrollback, nextOpacity = opacity) => {
      opacity = nextOpacity;
      frames.request(force);
    };
    draw = (force) => {
      const native = terminal.wasmTerm;
      if (!native) return;
      // Electron windows can move between monitors without changing the
      // terminal's CSS grid. Ghostty captures the pixel ratio only at open().
      if (pixels.devicePixelRatio !== window.devicePixelRatio) {
        pixels.devicePixelRatio = window.devicePixelRatio;
        renderer.resize(terminal.cols, terminal.rows);
        force = true;
      }
      const cursor = native.getCursor();
      const dimensions = native.getDimensions();
      let viewport: ReturnType<typeof native.getViewport> | undefined;
      const lines: ReturnType<typeof native.getLine>[] = [];
      const offset = Math.floor(terminal.viewportY);
      const frame: Parameters<typeof paint>[0] = {
        getCursor: () => cursor,
        getDimensions: () => dimensions,
        isRowDirty: (row) => native.isRowDirty(row),
        needsFullRedraw: () => native.needsFullRedraw(),
        clearDirty: () => native.clearDirty(),
        // The renderer supplies screen coordinates, including when it paints
        // scrollback. Graphemes must come from the same buffer as their cells.
        getGraphemeString: (row, col) =>
          row < offset
            ? native.getScrollbackGraphemeString(native.getScrollbackLength() - offset + row, col)
            : native.getGraphemeString(row - offset, col),
        getLine(row) {
          const { cols, rows } = dimensions;
          if (row < 0 || row >= rows) return null;
          if (!lines[row]) {
            viewport ??= native.getViewport();
            // Rendering is synchronous and does not mutate the cell pool.
            lines[row] = viewport.slice(row * cols, (row + 1) * cols);
          }
          return lines[row];
        },
      };
      // Ghostty skips the scrollbar entirely at opacity 0, leaving its last
      // pixels behind unless the text underneath is repainted once.
      paint(frame, force || (paintedOpacity > 0 && opacity === 0), offset, terminal, opacity);
      paintedOpacity = opacity;
      if (cursor.y !== driver.lastCursorY) {
        driver.lastCursorY = cursor.y;
        driver.cursorMoveEmitter.fire();
      }
    };
    frames.request(true);
  };
  const dispose = terminal.dispose.bind(terminal);
  terminal.dispose = () => {
    frames.dispose();
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("resize", displayResize);
    scroll.dispose();
    input.dispose();
    dispose();
  };
  return {
    setActive(value: boolean) {
      active = value;
      visibility();
    },
  };
}
