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

test("terminal zoom supports native plus/minus/reset, shifted plus, keypad and keyboard layouts", () => {
  for (const mac of [true, false]) {
    const key = { ...input, meta: mac, control: !mac };
    for (const code of ["Equal", "NumpadAdd"]) {
      expect(terminalShortcut({ ...key, code }, true, mac)).toBe("zoom-in");
      expect(terminalShortcut({ ...key, code, shift: true }, true, mac)).toBe("zoom-in");
      expect(terminalShortcut({ ...key, code }, false, mac)).toBeUndefined();
    }
    expect(terminalShortcut({ ...key, code: "BracketRight", key: "+" }, true, mac)).toBe("zoom-in");
    for (const code of ["Minus", "NumpadSubtract"])
      expect(terminalShortcut({ ...key, code }, true, mac)).toBe("zoom-out");
    expect(terminalShortcut({ ...key, code: "Slash", key: "-" }, true, mac)).toBe("zoom-out");
    expect(terminalShortcut({ ...key, code: "Digit0" }, true, mac)).toBe("zoom-reset");
    expect(terminalShortcut({ ...key, code: "Numpad0" }, true, mac)).toBe("zoom-reset");
    expect(terminalShortcut({ ...key, code: "Minus", shift: true }, true, mac)).toBeUndefined();
    expect(terminalShortcut({ ...key, code: "Equal", alt: true }, true, mac)).toBeUndefined();
  }
  expect(terminalShortcut({ ...input, code: "Equal", meta: false }, true, true)).toBeUndefined();
});
