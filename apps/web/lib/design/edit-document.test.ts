import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode } from "./document";
import {
  changedLayers,
  movedLayers,
  editLayers,
  moveLayers,
  trackDocumentChanges,
} from "./edit-document";

test("prepared layer transactions retain validation and import ownership at commit", () => {
  const document = {
    ...blankDesignDocument(),
    nodes: [
      {
        ...buildDrawnNode("a", "container", null, { x: 0, y: 0, width: 100, height: 80 }),
        importKey: "site:/",
        sourceKey: "a",
      },
    ],
  };
  const changes = { style: { radius: 12 } };
  expect(
    trackDocumentChanges(document, { ...document, nodes: changedLayers(document, ["a"], changes) }),
  ).toEqual(trackDocumentChanges(document, editLayers(document, ["a"], changes)));
  expect(
    trackDocumentChanges(document, { ...document, nodes: movedLayers(document, ["a"], 5, 10) }),
  ).toEqual(trackDocumentChanges(document, moveLayers(document, ["a"], 5, 10)));
  for (const invalid of [{ parentId: "missing" }, { box: { width: -1 } }, { variant: "missing" }]) {
    expect(() =>
      trackDocumentChanges(document, {
        ...document,
        nodes: changedLayers(document, ["a"], invalid),
      }),
    ).toThrow();
  }
  expect(document.nodes[0].style.radius).toBeUndefined();
  expect(document.editedNodeIds).toEqual([]);
});
