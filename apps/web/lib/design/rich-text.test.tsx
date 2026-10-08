import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  richTextSchema,
  richTextPlain,
  replacePlainText,
  textFontSegments,
  type RichText,
} from "@bella/design/rich-text";
import {
  blankDesignDocument,
  buildDrawnNode,
  parseDesignDocument,
  designNodeChangesSchema,
} from "./document";
import { editLayers, duplicateLayers } from "./edit-document";
import { diffDocument, applyDocumentPatch, invertPatch } from "./document-patch";
import { copyLayers, readDesignClipboard, pasteLayers } from "./clipboard";
import { resolveVariantNodes } from "./component-variants";
import { nodeStyle } from "@tidy/design-renderer/node-style";
import { DesignText } from "@tidy/design-renderer/design-text";
import { exportComponent } from "./code-export";
import { documentFontReferences } from "./fonts/recovery";

const richText: RichText = [
  {
    runs: [
      { text: "Hello " },
      { text: "bold", bold: true },
      { text: " link", italic: true, underline: true, href: "https://example.com" },
    ],
  },
  { list: "ordered", runs: [{ text: "First", strike: true }] },
  { list: "ordered", runs: [{ text: "Second" }] },
  { runs: [{ text: "" }] },
];
function fixture() {
  return parseDesignDocument({
    ...blankDesignDocument(),
    nodes: [
      {
        ...buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 400, height: 400 }),
        isComponent: true,
      },
      {
        ...buildDrawnNode("text", "text", "frame", { x: 10, y: 10, width: 300, height: 200 }),
        text: richTextPlain(richText),
        richText,
      },
    ],
  });
}
test("plain files remain plain; rich text validates bounded content and safe links", () => {
  const plain = fixture();
  delete plain.nodes[1].richText;
  expect(parseDesignDocument(plain).nodes[1].richText).toBeUndefined();
  expect(() =>
    parseDesignDocument({
      ...fixture(),
      nodes: fixture().nodes.map((node) =>
        node.type === "text" ? { ...node, text: "wrong" } : node,
      ),
    }),
  ).toThrow("must match");
  expect(
    richTextSchema.safeParse([{ runs: [{ text: "evil", href: "javascript:alert(1)" }] }]).success,
  ).toBe(false);
  expect(richTextSchema.safeParse([{ runs: [{ text: "x".repeat(10001) }] }]).success).toBe(false);
  expect(richTextSchema.safeParse([{ runs: [{ text: "a", onclick: "bad" }] }]).success).toBe(false);
});
test("plain-content replacement preserves unedited runs, list structure and blank lines", () => {
  const node = fixture().nodes[1];
  const next = replacePlainText(
    { text: node.text!, richText },
    node.text!.replace("bold", "bolder"),
  );
  expect(next.richText![0].runs[1]).toEqual({ text: "bolder", bold: true });
  expect(next.richText!.slice(1)).toEqual(richText.slice(1));
  expect(richTextPlain(next.richText!)).toBe(next.text);
  const removed = replacePlainText({ text: node.text!, richText }, "");
  expect(removed.richText).toEqual([{ runs: [{ text: "" }] }]);
});
test("MCP edits, multiplayer patches and one-step undo/redo retain paired text and formatting", () => {
  const before = fixture();
  expect(() =>
    editLayers(before, ["text"], { text: "Mismatch", richText: [{ runs: [{ text: "Other" }] }] }),
  ).toThrow("must match");
  const change = designNodeChangesSchema.parse({
    richText: [{ runs: [{ text: "New", italic: true }] }],
  });
  const after = editLayers(before, ["text"], change),
    patch = diffDocument(before, after);
  expect(after.nodes[1].text).toBe("New");
  expect(applyDocumentPatch(before, JSON.parse(JSON.stringify(patch)))).toEqual(after);
  expect(applyDocumentPatch(after, invertPatch(patch), true)).toEqual(before);
  expect(parseDesignDocument(JSON.parse(JSON.stringify(after)))).toEqual(after);
  const concurrent = editLayers(before, ["text"], {
    richText: [{ runs: [{ text: "Other", bold: true }] }],
  });
  expect(() => applyDocumentPatch(concurrent, invertPatch(patch), true)).toThrow(
    "changed elsewhere",
  );
  const legacyPatch = diffDocument(
    before,
    editLayers(before, ["text"], { text: before.nodes[1].text!.replace("bold", "BOLD") }),
  ).filter((p) => p.path[0] !== "richText");
  expect(applyDocumentPatch(before, legacyPatch).nodes[1].richText![0].runs[1]).toEqual({
    text: "BOLD",
    bold: true,
  });
});
test("component instances inherit rich text and preserve explicit content/format overrides", () => {
  const document = fixture();
  document.nodes.push(
    {
      ...document.nodes[0],
      id: "copy",
      box: { ...document.nodes[0].box, x: 450 },
      isComponent: undefined,
      instanceOf: "frame",
      componentSourceId: "frame",
    },
    {
      ...document.nodes[1],
      id: "copy-text",
      parentId: "copy",
      instanceOf: "frame",
      componentSourceId: "text",
    },
  );
  const inherited = editLayers(document, ["text"], {
    richText: [{ runs: [{ text: "Shared", bold: true }] }],
  });
  expect(inherited.nodes[3].richText).toEqual(inherited.nodes[1].richText);
  const overridden = editLayers(inherited, ["copy-text"], {
    richText: [{ runs: [{ text: "Mine", italic: true }] }],
  });
  expect(overridden.nodes[3].instanceOverrides).toEqual(
    expect.arrayContaining(["text", "richText"]),
  );
  const changed = editLayers(overridden, ["text"], { text: "Later" });
  expect(changed.nodes[3].text).toBe("Mine");
  expect(changed.nodes[3].richText![0].runs[0].italic).toBe(true);
});
test("variants, duplicates and cross-file clipboard preserve all runs and paragraphs", () => {
  const before = fixture();
  before.nodes[0].variants = {
    default: "primary",
    options: {
      primary: {},
      other: {
        children: { text: { richText: [{ runs: [{ text: "Variant", underline: true }] }] } },
      },
    },
  };
  before.nodes[0].variant = "other";
  expect(resolveVariantNodes(before.nodes)[1]).toMatchObject({
    text: "Variant",
    richText: [{ runs: [{ text: "Variant", underline: true }] }],
  });
  const duplicate = duplicateLayers(
    before,
    ["frame"],
    (() => {
      let n = 0;
      return () => `dup-${++n}`;
    })(),
  );
  expect(duplicate.document.nodes[3].richText).toEqual(richText);
  const payload = readDesignClipboard(copyLayers(before, ["frame"], "source"))!;
  const pasted = pasteLayers(blankDesignDocument(), payload, {
    fileId: "other",
    pageId: "page-1",
    parentId: null,
    createId: (() => {
      let n = 0;
      return () => `paste-${++n}`;
    })(),
  });
  expect(pasted.document.nodes[1].richText).toEqual(richText);
  expect(resolveVariantNodes(pasted.document.nodes)[1].text).toBe("Variant");
});
test("shared renderer and portable export keep links, emphasis, list numbering and empty paragraphs", () => {
  const document = fixture();
  const markup = renderToStaticMarkup(<DesignText node={document.nodes[1]} />);
  expect(markup).toContain("font-weight:700");
  expect(markup).toContain("font-style:italic");
  expect(markup).toContain('href="https://example.com"');
  expect(markup).toContain("<ol");
  expect(markup.match(/<li /g)).toHaveLength(2);
  expect(markup).toContain("<br/>");
  const exported = exportComponent(document, "frame", "Card");
  expect(exported.files[0].content).toContain('"richText"');
  expect(exported.files[0].content).toContain("https://example.com");
});
test("font loading and embedding enumerate regular, bold and italic faces including variants", () => {
  const document = fixture();
  expect(textFontSegments({ ...document.nodes[1], text: document.nodes[1].text! })).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: "bold", weight: 700, italic: false }),
      expect.objectContaining({ text: " link", weight: 400, italic: true }),
    ]),
  );
  document.nodes[0].variants = {
    default: "primary",
    options: {
      primary: {},
      other: {
        children: { text: { richText: [{ runs: [{ text: "Both", bold: true, italic: true }] }] } },
      },
    },
  };
  expect(documentFontReferences(document)).toContainEqual(
    expect.objectContaining({
      text: "Both",
      style: expect.objectContaining({ fontWeight: 700, fontStyle: "italic" }),
    }),
  );
});

test("run decorations can clear inherited layer underline without painting through other runs", () => {
  const node = {
    ...fixture().nodes[1],
    style: { ...fixture().nodes[1].style, textDecoration: "underline" as const },
    text: "Under Plain",
    richText: [{ runs: [{ text: "Under " }, { text: "Plain", underline: false }] }],
  };
  expect(nodeStyle(node, "absolute", {}).textDecoration).toBe("none");
  const markup = renderToStaticMarkup(<DesignText node={node} />);
  expect(markup).toContain("text-decoration:underline");
  expect(markup).toContain("text-decoration:none");
});
