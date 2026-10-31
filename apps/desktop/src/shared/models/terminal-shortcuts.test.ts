import { expect, test } from "bun:test";
import { terminalShortcut } from "./terminal-shortcuts";

const input = { code: "KeyT", control: false, meta: true, alt: false, shift: false };
test("terminal menu accelerators require terminal focus and the platform modifier", () => {
  expect(terminalShortcut(input, false, true)).toBeUndefined();
  expect(terminalShortcut(input, true, true)).toBe("new");
  expect(terminalShortcut(input, true, false)).toBeUndefined();
  expect(terminalShortcut({ ...input, meta: false, control: true }, true, false)).toBe("new");
  expect(terminalShortcut({ ...input, code: "KeyW" }, true, true)).toBe("close");
  expect(terminalShortcut({ ...input, code: "Enter" }, true, true)).toBe("maximize");
  expect(terminalShortcut({ ...input, code: "Digit8" }, true, true)).toBe("select-8");
});
test("global toggle and new-tab shortcuts work outside the terminal", () => {
  const key = { ...input, code: "Backquote", meta: false, control: true };
  expect(terminalShortcut(key, false, true)).toBe("toggle");
  expect(terminalShortcut({ ...key, shift: true }, false, true)).toBe("new");
  expect(terminalShortcut({ ...key, alt: true }, false, true)).toBeUndefined();
});
test("tab cycling preserves control characters and editor keys", () => {
  const key = { ...input, code: "Tab", meta: false, control: true };
  expect(terminalShortcut(key, true, true)).toBe("next");
  expect(terminalShortcut({ ...key, shift: true }, true, true)).toBe("previous");
  expect(terminalShortcut(key, false, true)).toBeUndefined();
  for (const code of ["KeyC", "KeyD", "Escape", "Enter", "KeyL"]) {
    expect(terminalShortcut({ ...key, code }, true, true)).toBeUndefined();
  }
});
