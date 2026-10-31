import { Ghostty, Terminal, FitAddon } from "ghostty-web";
import wasmURL from "ghostty-web/ghostty-vt.wasm?url";

let runtime: Promise<Ghostty> | undefined;
export async function createTerminal() {
  runtime ??= Ghostty.load(wasmURL).catch((error: unknown) => {
    runtime = undefined;
    throw error;
  });
  const ghostty = await runtime;
  const terminal = new Terminal({
    ghostty,
    fontSize: 13,
    fontFamily:
      '"SF Mono", "Cascadia Code", "DejaVu Sans Mono", Menlo, Consolas, "Symbols Nerd Font Mono", "Symbols Nerd Font", "JetBrainsMono Nerd Font", monospace',
    scrollback: 5000,
    cursorBlink: false,
    smoothScrollDuration: 0,
    theme: {
      background: "#18181b",
      foreground: "#e4e4e7",
      cursor: "#e4e4e7",
      selectionBackground: "#3f3f46",
      selectionForeground: "#fafafa",
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  let active = true;
  // Ghostty's default focus schedules another focus later, which can steal it from the composer.
  terminal.focus = () =>
    terminal.element
      ?.querySelector<HTMLTextAreaElement>("textarea")
      ?.focus({ preventScroll: true });
  const open = terminal.open.bind(terminal);
  terminal.open = (element) => {
    open(element);
    const renderer = terminal.renderer!;
    const paint = renderer.render.bind(renderer);
    renderer.render = (buffer, force, viewportY, scrollback, opacity) => {
      if (!active) return;
      const native = terminal.wasmTerm;
      if (!native || buffer !== native) return paint(buffer, force, viewportY, scrollback, opacity);
      let viewport: ReturnType<typeof native.getViewport> | undefined;
      // ghostty-web's getLine decodes the entire viewport for each row. Read it once per paint.
      const frame: Parameters<typeof paint>[0] = {
        getCursor: () => native.getCursor(),
        getDimensions: () => native.getDimensions(),
        isRowDirty: (row) => native.isRowDirty(row),
        needsFullRedraw: () => native.needsFullRedraw(),
        clearDirty: () => native.clearDirty(),
        getGraphemeString: (row, col) => native.getGraphemeString(row, col),
        getLine(row) {
          const { cols, rows } = native.getDimensions();
          if (row < 0 || row >= rows) return null;
          viewport ??= native.getViewport();
          return viewport.slice(row * cols, (row + 1) * cols).map((cell) => ({ ...cell }));
        },
      };
      return paint(frame, force, viewportY, scrollback, opacity);
    };
  };
  return {
    terminal,
    fit,
    setActive(value: boolean) {
      active = value;
    },
  };
}
