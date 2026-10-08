import { test, expect } from "bun:test";
import { blankDesignDocument, parseDesignDocument } from "./document";
import { addGuide, moveGuide, removeGuide } from "./guides";
import { applyDocumentPatch, diffDocument, invertPatch } from "./document-patch";
import { duplicatePage } from "./pages";

const firstId = "00000000-0000-4000-8000-000000000101";
const copyId = "00000000-0000-4000-8000-000000000102";

test("page guides persist through patches, undo, and duplication", () => {
  const before = blankDesignDocument();
  const added = addGuide(before, "page-1", { id: firstId, axis: "x", position: 120 });
  const moved = moveGuide(added, "page-1", firstId, 145);
  expect(applyDocumentPatch(added, diffDocument(added, moved))).toEqual(moved);
  expect(applyDocumentPatch(moved, invertPatch(diffDocument(added, moved)))).toEqual(added);
  expect(duplicatePage(moved, "page-1", "page-2", () => copyId).pages[1].guides).toEqual([
    { id: copyId, axis: "x", position: 145 },
  ]);
  expect(removeGuide(moved, "page-1", firstId).pages[0].guides).toEqual([]);
  expect(before.pages[0].guides).toBeUndefined();
});

test("guides are bounded and unique within a page", () => {
  const document = blankDesignDocument();
  const guide = { id: firstId, axis: "y", position: 0 };
  expect(() => addGuide(addGuide(document, "page-1", guide), "page-1", guide)).toThrow(
    "Duplicate guide ID",
  );
  expect(() => addGuide(document, "page-1", { ...guide, position: 100001 })).toThrow();
  expect(() =>
    parseDesignDocument({
      ...document,
      pages: [{ id: "page-1", name: "Page 1", guides: [{ ...guide, axis: "z" }] }],
    }),
  ).toThrow();
});
