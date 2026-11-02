import { expect, test } from "bun:test";
import {
  currentTerminalFontSize,
  selectTerminalFontSize,
  subscribeTerminalFontSize,
} from "./terminal-preferences";

test("settings and zoom share a validated preference that still updates if storage fails", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        return saved.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        saved.set(key, value);
      },
    },
  });
  selectTerminalFontSize(13);
  const sizes: number[] = [];
  const stop = subscribeTerminalFontSize(() => sizes.push(currentTerminalFontSize()));
  try {
    expect(selectTerminalFontSize(16)).toBe(true);
    expect(saved.get("tidy:terminal-font-size")).toBe("16");
    expect(selectTerminalFontSize(16)).toBe(true);
    for (const size of [7, 33, 14.5, NaN]) expect(selectTerminalFontSize(size)).toBe(false);
    expect(sizes).toEqual([16]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        setItem() {
          throw new Error("Storage unavailable");
        },
      },
    });
    expect(selectTerminalFontSize(18)).toBe(false);
    expect(currentTerminalFontSize()).toBe(18);
    expect(sizes).toEqual([16, 18]);
    stop();
    selectTerminalFontSize(20);
    expect(sizes).toEqual([16, 18]);
  } finally {
    stop();
    selectTerminalFontSize(13);
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
