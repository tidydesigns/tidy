import { expect, test } from "bun:test";
import { isFeedbackShortcut } from "./commands";

function key(overrides: Partial<KeyboardEvent> = {}) {
  return {
    key: "F",
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    ...overrides,
  } as KeyboardEvent;
}

test("feedback requires a non-character modifier on Windows and Mac", () => {
  expect(isFeedbackShortcut(key())).toBe(false);
  expect(isFeedbackShortcut(key({ ctrlKey: true }))).toBe(true);
  expect(isFeedbackShortcut(key({ metaKey: true }))).toBe(true);
  expect(isFeedbackShortcut(key({ ctrlKey: true, shiftKey: false }))).toBe(false);
});

test("feedback does not reopen for repeated, composing, or already handled keys", () => {
  for (const overrides of [
    { repeat: true },
    { isComposing: true },
    { defaultPrevented: true },
    { altKey: true },
    { key: "G" },
  ]) {
    expect(isFeedbackShortcut(key({ ctrlKey: true, ...overrides }))).toBe(false);
  }
});
