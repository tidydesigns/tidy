import type { TerminalShortcut } from "../contracts/terminal";

export function terminalShortcut(
  input: {
    code: string;
    key?: string;
    control: boolean;
    meta: boolean;
    alt: boolean;
    shift: boolean;
  },
  focused: boolean,
  mac: boolean,
): TerminalShortcut | undefined {
  if (input.control && !input.meta && !input.alt && input.code === "Backquote")
    return input.shift ? "new" : "toggle";
  if (!focused) return;
  if (input.control && !input.meta && !input.alt && input.code === "Tab")
    return input.shift ? "previous" : "next";
  const mod = mac ? input.meta && !input.control : input.control && !input.meta;
  if (!mod || input.alt) return;
  // Cmd+= and Cmd+Shift+= both mean zoom in; key also supports non-US layouts.
  if (input.key === "+" || input.code === "Equal" || input.code === "NumpadAdd") return "zoom-in";
  if (
    input.key === "-" ||
    input.code === "NumpadSubtract" ||
    (!input.shift && input.code === "Minus")
  )
    return "zoom-out";
  if (!input.shift && (input.key === "0" || input.code === "Digit0" || input.code === "Numpad0"))
    return "zoom-reset";
  if (input.shift) {
    if (input.code === "BracketLeft") return "previous";
    if (input.code === "BracketRight") return "next";
    return;
  }
  if (input.code === "KeyT") return "new";
  if (input.code === "KeyW") return "close";
  if (input.code === "Enter") return "maximize";
  if (/^Digit[1-8]$/.test(input.code)) return `select-${input.code.slice(-1)}` as TerminalShortcut;
}
