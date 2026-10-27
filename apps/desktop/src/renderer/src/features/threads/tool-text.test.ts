import { expect, test } from "bun:test";
import { toolTextPreview } from "./tool-text";

test("tool previews retain up to four lines, including blank lines and trailing newlines", () => {
  expect(toolTextPreview("")).toBe("");
  expect(toolTextPreview("one\ntwo\nthree\nfour")).toBe("one\ntwo\nthree\nfour");
  expect(toolTextPreview("one\ntwo\nthree\nfour\nfive")).toBe("one\ntwo\nthree\nfour");
  expect(toolTextPreview("one\n\nthree\n")).toBe("one\n\nthree\n");
  expect(toolTextPreview("one\r\ntwo\r\nthree\r\nfour\r\nfive")).toBe(
    "one\r\ntwo\r\nthree\r\nfour\r",
  );
});

test("tool previews bound long lines without changing the visible prefix", () => {
  expect(toolTextPreview("x".repeat(32_000))).toBe("x".repeat(480));
  expect(toolTextPreview(`${"x".repeat(479)}\nmore`)).toBe(`${"x".repeat(479)}\n`);
  expect(toolTextPreview(`${"x".repeat(478)}\nmore`)).toBe(`${"x".repeat(478)}\nm`);
});
