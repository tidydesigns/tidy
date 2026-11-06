import { installTerminalResponses } from "./terminal-responses";
import { terminalDriver } from "./terminal-driver";
import { terminalFont } from "./terminal-font";
import { fitTerminal } from "./terminal-fit";
import { Ghostty, Terminal, FitAddon, type ITheme } from "ghostty-web";
import wasmURL from "ghostty-web/ghostty-vt.wasm?url";
import { terminalWasm } from "./terminal-wasm";

const loadRuntime = terminalWasm(async () => {
  const response = await fetch(wasmURL);
  if (!response.ok) throw new Error("Could not load the terminal runtime.");
  return response.arrayBuffer();
});
export async function createTerminal(theme: ITheme, size?: { cols: number; rows: number }) {
  const ghostty = new Ghostty(await loadRuntime());
  const terminal = new Terminal({
    ghostty,
    cols: size?.cols,
    rows: size?.rows,
    fontSize: terminalFont.default,
    fontFamily:
      '"SF Mono", "Cascadia Code", "DejaVu Sans Mono", Menlo, Consolas, "Symbols Nerd Font Mono", "Symbols Nerd Font", "JetBrainsMono Nerd Font", monospace',
    scrollback: 5000,
    cursorBlink: false,
    smoothScrollDuration: 0,
    theme,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  fit.fit = () => fitTerminal({ terminal, fit });
  installTerminalResponses(terminal);
  const driver = terminalDriver(terminal);
  // Ghostty's default focus schedules another focus later, which can steal it from the composer.
  terminal.focus = () =>
    terminal.element
      ?.querySelector<HTMLTextAreaElement>("textarea")
      ?.focus({ preventScroll: true });
  return { terminal, fit, setActive: driver.setActive };
}
