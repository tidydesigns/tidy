import { expect, test } from "bun:test";
import { richTextSchema } from "@tidy/design/rich-text";
import { formatNodeText, nodeTextFormatting } from "./text-formatting";

test("whole-layer formatting reflects inherited typography and can override it", () => {
  const node = {
    text: "Heading",
    style: {
      fontWeight: 700,
      fontStyle: "italic",
      textDecoration: "underline",
    },
  } as const;
  expect(nodeTextFormatting(node).marks).toMatchObject({
    bold: true,
    italic: true,
    underline: true,
  });
  const result = formatNodeText({ node, command: "bold" });
  expect(result.richText?.[0].runs).toEqual([{ text: "Heading", bold: false }]);
  expect(nodeTextFormatting({ ...node, ...result }).marks).toMatchObject({
    bold: false,
    italic: true,
    underline: true,
  });
});

test("mixed formatting toggles consistently without changing text or paragraphs", () => {
  const node = {
    text: "First\n\nLast",
    style: {},
    richText: [
      { runs: [{ text: "First", bold: true }], list: "bullet" },
      { runs: [{ text: "" }] },
      { runs: [{ text: "Last", italic: true }] },
    ],
  } as const;
  const editable = { ...node, richText: richTextSchema.parse(node.richText) };
  expect(nodeTextFormatting(editable).marks.bold).toBe("mixed");
  const result = formatNodeText({ node: editable, command: "bold" });
  expect(result.text).toBe(node.text);
  expect(result.richText?.length).toBe(3);
  expect(result.richText?.[0].list).toBe("bullet");
  expect(nodeTextFormatting({ ...editable, ...result }).marks.bold).toBe(true);
  expect(result.richText?.[2].runs[0].italic).toBe(true);
  expect(richTextSchema.safeParse(result.richText).success).toBe(true);
});

test("list commands apply and remove paragraph lists while preserving inline marks", () => {
  const node = {
    text: "One\nTwo",
    style: {},
    richText: [
      { list: "bullet", runs: [{ text: "One", italic: true }] },
      { runs: [{ text: "Two" }] },
    ],
  };
  const editable = { ...node, richText: richTextSchema.parse(node.richText) };
  const result = formatNodeText({
    node: editable,
    command: "insertOrderedList",
  });
  expect(result.richText?.map((paragraph) => paragraph.list)).toEqual(["ordered", "ordered"]);
  const cleared = formatNodeText({
    node: { ...editable, ...result },
    command: "insertOrderedList",
  });
  expect(cleared.richText?.map((paragraph) => paragraph.list)).toEqual([undefined, undefined]);
  expect(cleared.richText?.[0].runs[0].italic).toBe(true);
});

test("invalid links leave content unchanged and unlink preserves text", () => {
  const node = { text: "Safe link", style: {} };
  expect(
    formatNodeText({
      node,
      command: "createLink",
      value: "javascript:alert(1)",
    }),
  ).toEqual({
    text: node.text,
    richText: undefined,
  });
  const linked = formatNodeText({
    node,
    command: "createLink",
    value: "https://example.com",
  });
  expect(nodeTextFormatting({ ...node, ...linked }).href).toBe("https://example.com");
  const rejected = formatNodeText({
    node: { ...node, ...linked },
    command: "createLink",
    value: "javascript:alert(1)",
  });
  expect(rejected).toEqual(linked);
  const cleared = formatNodeText({
    node: { ...node, ...linked },
    command: "unlink",
  });
  expect(cleared.richText?.[0].runs).toEqual([{ text: "Safe link", href: undefined }]);
  expect(cleared.text).toBe(node.text);
});
