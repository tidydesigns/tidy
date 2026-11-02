import { terminalFont } from "./terminal-font";

const storageKey = "tidy:terminal-font-size";
const listeners = new Set<() => void>();
let cached: number | undefined;

function read() {
  try {
    const value = Number(localStorage.getItem(storageKey));
    if (Number.isInteger(value) && value >= terminalFont.min && value <= terminalFont.max)
      return value;
  } catch {}
  return terminalFont.default;
}
export function currentTerminalFontSize() {
  return (cached ??= read());
}
export function subscribeTerminalFontSize(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function selectTerminalFontSize(value: number) {
  if (!Number.isInteger(value) || value < terminalFont.min || value > terminalFont.max)
    return false;
  if (value === currentTerminalFontSize()) return true;
  cached = value;
  for (const listener of listeners) listener();
  try {
    localStorage.setItem(storageKey, String(value));
    return true;
  } catch {
    return false;
  }
}
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    const next = read();
    if (next === cached) return;
    cached = next;
    for (const listener of listeners) listener();
  });
