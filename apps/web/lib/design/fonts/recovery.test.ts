import { test, expect } from "bun:test";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "../document";
import { createComponentInstance } from "../document-operations";
import { resolveVariantNodes } from "../component-variants";
import { diffDocument, applyDocumentPatch, invertPatch } from "../document-patch";
import { documentFontReferences, replaceDocumentFont } from "./recovery";
import type { FontFamily } from "./font-utils";
const target: FontFamily = {
  family: "Available",
  source: "local",
  category: "Local",
  styles: [
    { weight: 400, italic: false, face: "Available Regular", label: "Regular" },
    { weight: 700, italic: true, face: "Available Bold Italic", label: "Bold Italic" },
  ],
};
const box = { x: 0, y: 0, width: 100, height: 50 };
test("file replacement includes hidden/locked pages, instances and inactive font variants in one undoable edit", () => {
  const label = {
    ...buildDrawnNode("label", "text", "master", box),
    text: "Keep me",
    style: {
      fontFamily: "Missing, serif",
      fontSource: "local" as const,
      fontFace: "Old Face",
      fontWeight: 500,
      color: "#123456",
    },
  };
  const document = parseDesignDocument({
    ...blankDesignDocument(),
    pages: [
      { id: "page-1", name: "One" },
      { id: "page-2", name: "Two" },
    ],
    nodes: [
      {
        ...buildDrawnNode("master", "container", null, box),
        isComponent: true,
        variants: {
          default: "regular",
          options: {
            regular: {},
            emphasis: { children: { label: { style: { fontWeight: 800, fontStyle: "italic" } } } },
          },
        },
      },
      label,
      { ...label, id: "hidden", parentId: null, pageId: "page-2", visible: false, locked: true },
      { ...label, id: "web", parentId: null, style: { ...label.style, fontSource: "web" } },
      { ...label, id: "other", parentId: null, style: { fontFamily: "Other" } },
    ],
  });
  let id = 0;
  const before = createComponentInstance(document, "master", () => `copy-${++id}`).document;
  expect(documentFontReferences(before).some((ref) => ref.style.fontWeight === 800)).toBe(true);
  const after = replaceDocumentFont(before, { family: "MISSING", source: "local" }, target);
  for (const name of ["label", "hidden", "copy-2"])
    expect(after.nodes.find((node) => node.id === name)?.style).toMatchObject({
      fontFamily: "Available",
      fontWeight: 400,
      fontFace: "Available Regular",
      color: "#123456",
    });
  expect(after.nodes.find((node) => node.id === "web")).toEqual(
    before.nodes.find((node) => node.id === "web"),
  );
  expect(after.nodes.find((node) => node.id === "other")).toEqual(
    before.nodes.find((node) => node.id === "other"),
  );
  const variant = after.nodes[0].variants!.options.emphasis.children!.label.style!;
  expect(variant.fontFamily).toBeUndefined();
  expect(variant).toMatchObject({
    fontWeight: 700,
    fontStyle: "italic",
    fontFace: "Available Bold Italic",
  });
  expect(
    resolveVariantNodes(after.nodes, new Map([["master", "emphasis"]])).find(
      (node) => node.id === "label",
    )?.style.fontFace,
  ).toBe("Available Bold Italic");
  expect(after.nodes.find((node) => node.id === "hidden")).toMatchObject({
    locked: true,
    visible: false,
    text: "Keep me",
  });
  const patch = diffDocument(before, after);
  expect(applyDocumentPatch(before, patch)).toEqual(after);
  expect(applyDocumentPatch(after, invertPatch(patch))).toEqual(before);
  expect(
    parseDesignDocument(JSON.parse(JSON.stringify(after))).nodes.find((node) => node.id === "label")
      ?.style.fontFace,
  ).toBe("Available Regular");
});
test("variant-only families are replaced without changing an available base or inventing styles", () => {
  const node = {
    ...buildDrawnNode("text", "text", null, box),
    isComponent: true,
    style: { fontFamily: "Base" },
    variants: {
      default: "base",
      options: {
        base: {},
        alternate: {
          root: {
            style: {
              fontFamily: "Missing",
              fontSource: "local",
              fontWeight: 900,
              fontStyle: "italic",
            },
          },
        },
      },
    },
  };
  const before = parseDesignDocument({ ...blankDesignDocument(), nodes: [node] });
  const after = replaceDocumentFont(
    before,
    { family: "Missing", source: "local" },
    { ...target, source: "web", styles: [{ ...target.styles[0], face: undefined }] },
  );
  expect(after.nodes[0].style.fontFamily).toBe("Base");
  const rendered = resolveVariantNodes(after.nodes, new Map([["text", "alternate"]]))[0];
  expect(rendered.style.fontFace).toBeUndefined();
  expect(rendered.style).toMatchObject({
    fontFamily: "Available",
    fontSource: "web",
    fontWeight: 400,
    fontStyle: "normal",
  });
});
