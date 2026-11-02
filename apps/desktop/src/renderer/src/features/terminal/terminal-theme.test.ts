import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { selectTheme } from "../../theme";
import { currentTerminalTheme, subscribeTerminalTheme, terminalThemes } from "./terminal-theme";

test("terminal colors follow explicit preferences and live system changes, and unsubscribe cleanly", async () => {
  const window = new Window();
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const changes = new Set<() => void>();
  const media = {
    matches: false,
    addEventListener: (_: string, listener: () => void) => changes.add(listener),
    removeEventListener: (_: string, listener: () => void) => changes.delete(listener),
  };
  Object.defineProperty(window, "matchMedia", { value: () => media });
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    localStorage: window.localStorage,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const seen: ReturnType<typeof currentTerminalTheme>[] = [];
  const stop = subscribeTerminalTheme(() => seen.push(currentTerminalTheme()));
  try {
    selectTheme("system");
    expect(currentTerminalTheme()).toBe(terminalThemes.light);
    media.matches = true;
    for (const change of changes) change();
    expect(seen.at(-1)).toBe(terminalThemes.dark);
    selectTheme("light");
    expect(currentTerminalTheme()).toBe(terminalThemes.light);
    const count = seen.length;
    media.matches = false;
    for (const change of changes) change();
    expect(seen).toHaveLength(count);
    selectTheme("dark");
    expect(currentTerminalTheme()).toBe(terminalThemes.dark);
    selectTheme("system");
    expect(currentTerminalTheme()).toBe(terminalThemes.light);
    stop();
    expect(changes.size).toBe(0);
    const stopped = seen.length;
    selectTheme("light");
    expect(seen).toHaveLength(stopped);
  } finally {
    stop();
    selectTheme("system");
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});

function luminance(hex: string) {
  const rgb = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

test("light-mode ANSI text remains legible on a white terminal", () => {
  const { background, cursorAccent, selectionBackground, ...text } = terminalThemes.light;
  for (const color of Object.values(text)) {
    const contrast = (luminance(background) + 0.05) / (luminance(color) + 0.05);
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  }
  expect(cursorAccent).toBe(background);
  expect(selectionBackground).not.toBe(background);
});
