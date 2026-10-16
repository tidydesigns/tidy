import { expect, test } from "bun:test";
import * as runtime from "./rich-text-runtime";
import * as validated from "./rich-text";

test("schema-free rich text entrypoint preserves the public helper exports", () => {
  for (const name of [
    "richTextPlain",
    "textParagraphs",
    "textFontSegments",
    "normalizeRichText",
    "replacePlainText",
  ] as const)
    expect(runtime[name]).toBe(validated[name]);
});

test("runtime edits retain list formatting and remain accepted by the validation boundary", () => {
  const richText = validated.richTextSchema.parse([
    { list: "bullet", runs: [{ text: "Hello", bold: true }] },
    { runs: [{ text: "World", italic: true, href: "/world" }] },
  ]);
  const edited = runtime.replacePlainText(
    { text: runtime.richTextPlain(richText), richText },
    "Hello!\nWorld",
  );
  expect(validated.richTextSchema.parse(edited.richText)).toEqual([
    { list: "bullet", runs: [{ text: "Hello!", bold: true }] },
    { runs: [{ text: "World", italic: true, href: "/world" }] },
  ]);
  expect(runtime.richTextPlain(edited.richText!)).toBe(edited.text);
  expect(runtime.textFontSegments({ ...edited, style: {} })).toEqual([
    { text: "Hello!", weight: 700, italic: false, face: undefined },
    { text: "World", weight: 400, italic: true, face: undefined },
  ]);
  expect(
    validated.richTextSchema.safeParse([
      { runs: [{ text: "unsafe", href: "javascript:alert(1)" }] },
    ]).success,
  ).toBe(false);
});
