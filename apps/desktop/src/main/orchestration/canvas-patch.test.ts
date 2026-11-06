import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "@tidy/design/document";
import { applyDocumentPatch, diffDocument, invertPatch } from "@tidy/editor/design/document-patch";
import { compactCanvasPatch, expandCanvasPatch } from "./canvas-patch";

function document(ids: string[]) {
  return parseDesignDocument({
    ...blankDesignDocument(),
    nodes: ids.map((id) =>
      buildDrawnNode(id, "container", null, { x: 0, y: 0, width: 10, height: 10 }),
    ),
  });
}

test("compact orders round-trip insertions, removals and moves with exact conflict checks", () => {
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let attempt = 0; attempt < 100; attempt++) {
    const ids = Array.from({ length: 30 }, (_, index) => `layer-${index}`);
    const changed = ids.filter(() => random() > 0.2);
    changed.push("added-a", "added-b");
    for (let index = changed.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [changed[index], changed[other]] = [changed[other], changed[index]];
    }
    const before = document(ids),
      after = document(changed);
    const patch = compactCanvasPatch(diffDocument(before, after));
    const result = applyDocumentPatch(before, expandCanvasPatch(patch, before), true);
    expect(result.nodes.map((node) => node.id)).toEqual(changed);
    const inverse = invertPatch(patch);
    const undone = applyDocumentPatch(result, expandCanvasPatch(inverse, result), true);
    expect(undone.nodes).toEqual(before.nodes);
    expect(() => expandCanvasPatch(inverse, document([...changed].reverse()))).toThrow(
      "order changed",
    );
  }
});

for (const [operation, change] of [
  ["single additions", (ids: string[]) => [...ids, "added"]],
  ["single removals", (ids: string[]) => ids.slice(1)],
  ["distant moves", (ids: string[]) => [...ids.slice(1), ids[0]]],
] as const)
  test(`${operation} have bounded order receipts at 10000 layers`, () => {
    const ids = Array.from(
      { length: 9999 },
      (_, index) => `layer-${index.toString().padStart(5, "0")}`,
    );
    const before = document(ids);
    const changed = change(ids);
    const after = document(changed);
    const patch = compactCanvasPatch(diffDocument(before, after));
    expect(Buffer.byteLength(JSON.stringify([patch, invertPatch(patch)]))).toBeLessThan(3000);
    const result = applyDocumentPatch(before, expandCanvasPatch(patch, before), true);
    expect(result.nodes.map((node) => node.id)).toEqual(changed);
    expect(
      applyDocumentPatch(result, expandCanvasPatch(invertPatch(patch), result), true).nodes,
    ).toEqual(before.nodes);
  });

test("import edit markers and deletion tombstones store set deltas instead of document-sized history", () => {
  const ids = Array.from({ length: 9999 }, (_, index) => `imported-${index}`);
  const before = document(ids);
  before.editedNodeIds = ids.slice(0, -1);
  before.deletedSourceKeys = ids.map((id) => ({ importKey: "source", sourceKey: id }));
  const after = parseDesignDocument({
    ...before,
    editedNodeIds: ids,
    deletedSourceKeys: [...before.deletedSourceKeys, { importKey: "source", sourceKey: "removed" }],
  });
  const patch = compactCanvasPatch(diffDocument(before, after));
  expect(Buffer.byteLength(JSON.stringify([patch, invertPatch(patch)]))).toBeLessThan(2000);
  const result = applyDocumentPatch(before, expandCanvasPatch(patch, before), true);
  expect(result.editedNodeIds).toEqual(after.editedNodeIds);
  expect(result.deletedSourceKeys).toEqual(after.deletedSourceKeys);
  const undone = applyDocumentPatch(result, expandCanvasPatch(invertPatch(patch), result), true);
  expect(undone.deletedSourceKeys).toEqual(before.deletedSourceKeys);
  expect(undone.editedNodeIds).toContain(ids.at(-1)!);
});
