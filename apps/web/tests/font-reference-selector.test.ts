import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode, type DesignDocument } from "@tidy/design/document";
import { documentFontReferences } from "../../../packages/editor/src/design/fonts/recovery";
import { createFontReferenceSelector } from "../../../packages/editor/src/editor/font-reference-selector";

const document: DesignDocument = {
  ...blankDesignDocument(),
  nodes: [
    buildDrawnNode("board", "artboard", null, { x: 0, y: 0, width: 600, height: 400 }),
    {
      ...buildDrawnNode("text", "text", "board", { x: 20, y: 20, width: 200, height: 40 }),
      text: "Example",
      style: { fontFamily: "system-ui", fontWeight: 400 },
    },
  ],
};

test("geometry-only edits reuse the font inventory without changing its contents", () => {
  const select = createFontReferenceSelector();
  const before = select(document);
  const moved = {
    ...document,
    nodes: document.nodes.map((node) => ({
      ...node,
      box: { ...node.box, x: node.box.x + 40, width: node.box.width + 10 },
    })),
  };
  expect(select(moved)).toBe(before);
  expect(select(moved)).toEqual(documentFontReferences(moved));
});

test("font, text, variant, and instance changes invalidate the inventory", () => {
  for (const changes of [
    { text: "New characters Ω" },
    { style: { fontFamily: "serif", fontWeight: 800 } },
    { componentSourceId: "master", instanceOf: "master" },
    { instanceOverrides: ["style.fontWeight"] },
    { variants: { default: "bold", options: { bold: { root: { style: { fontWeight: 800 } } } } } },
  ]) {
    const select = createFontReferenceSelector();
    const before = select(document);
    const changed = {
      ...document,
      nodes: document.nodes.map((node) => (node.id === "text" ? { ...node, ...changes } : node)),
    };
    expect(select(changed)).not.toBe(before);
    expect(select(changed)).toEqual(documentFontReferences(changed));
  }
});

test("insertion, removal, and conversion to a non-text layer update font references", () => {
  const select = createFontReferenceSelector();
  expect(select(document)).toHaveLength(1);
  const empty = { ...document, nodes: document.nodes.filter((node) => node.type !== "text") };
  expect(select(empty)).toEqual([]);
  expect(select(document)).toHaveLength(1);
  expect(
    select({
      ...document,
      nodes: document.nodes.map((node) => ({ ...node, type: "container" as const })),
    }),
  ).toEqual([]);
});
