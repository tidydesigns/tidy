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
  return { terminal, fit };
}
