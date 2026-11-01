import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseDesignDocument } from "@tidy/design/document";
import { documentPage } from "@tidy/editor/design/pages";
import { DocumentPreview } from "@tidy/editor/components/files/document-preview";

const document = parseDesignDocument({
  schemaVersion: 1,
  warnings: [],
  pages: [
    { id: "first", name: "First", background: "#d4d4d4" },
    { id: "second", name: "Second", background: "#e7dec9" },
    { id: "empty", name: "Empty" },
  ],
  nodes: ["first", "second"].map((pageId) => ({
    id: `${pageId}-artwork`,
    name: pageId,
    pageId,
    type: "container",
    parentId: null,
    box: { x: 200, y: -100, width: 300, height: 200 },
  })),
});

test("preview artwork and canvas background resolve the same selected page", () => {
  for (const pageId of ["first", "second"]) {
    const html = renderToStaticMarkup(
      createElement(DocumentPreview, { content: document, pageId }),
    );
    expect(html).toContain(`data-thumbnail-node="${pageId}-artwork"`);
    expect(html).not.toContain(
      `data-thumbnail-node="${pageId === "first" ? "second" : "first"}-artwork"`,
    );
    expect(documentPage(document, pageId).background).toBe(
      pageId === "first" ? "#d4d4d4" : "#e7dec9",
    );
  }
});

test("removed pages fall back to the same first page; empty pages stay empty", () => {
  const html = renderToStaticMarkup(
    createElement(DocumentPreview, { content: document, pageId: "removed" }),
  );
  expect(documentPage(document, "removed").id).toBe("first");
  expect(html).toContain('data-thumbnail-node="first-artwork"');
  expect(
    renderToStaticMarkup(createElement(DocumentPreview, { content: document, pageId: "empty" })),
  ).toBe("");
});

test("legacy documents without pages use the editor's implicit default page", () => {
  const legacy = parseDesignDocument({ schemaVersion: 1, nodes: [], warnings: [] });
  expect(documentPage(legacy).id).toBe("page-1");
});
