import { expect, test } from "bun:test";
import {
  blankDesignDocument,
  buildDrawnNode,
  isWebCaptureImportKey,
  parseDesignDocument,
} from "./document";
import { trackDocumentChanges } from "./edit-document";
import { removeLayers } from "./document-operations";
import { applyDocumentPatch, diffDocument, invertPatch } from "./document-patch";

const captureKey = "en.wikipedia.org:web-capture/00000000-0000-4000-8000-000000000001";
const duplicateKey = `${captureKey}#00000000-0000-4000-8000-000000000002`;
const legacyHistory = (length: number) =>
  Array.from({ length }, (_, index) => ({ importKey: captureKey, sourceKey: `old-${index}` }));
const captureNodes = (length: number) =>
  Array.from({ length }, (_, index) => ({
    ...buildDrawnNode(`layer-${index}`, "container", index === 0 ? null : "layer-0", {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    }),
    importKey: duplicateKey,
    sourceKey: `source-${index}`,
  }));

test("deleting a full 5000-layer capture succeeds with 5000 old deletion records", () => {
  const before = {
    ...blankDesignDocument(),
    nodes: captureNodes(5000),
    deletedSourceKeys: legacyHistory(5000),
  };
  const after = trackDocumentChanges(before, removeLayers(before, ["layer-0"]));
  expect(after.nodes).toEqual([]);
  expect(after.deletedSourceKeys).toEqual([]);
  expect(parseDesignDocument(after)).toEqual(after);
  const patch = diffDocument(before, after);
  expect(applyDocumentPatch(before, patch)).toEqual(after);
  const restored = applyDocumentPatch(after, invertPatch(patch), true);
  expect(restored.nodes).toEqual(before.nodes);
  expect(restored.deletedSourceKeys).toEqual([]);
  expect(applyDocumentPatch(restored, patch, true)).toEqual(after);
});

test("legacy capture history is cleaned without relaxing other imports' limits", () => {
  const retained = { importKey: "project:/page", sourceKey: "deleted-code-layer" };
  expect(
    parseDesignDocument({
      ...blankDesignDocument(),
      deletedSourceKeys: [...legacyHistory(9999), retained],
    }).deletedSourceKeys,
  ).toEqual([retained]);
  expect(() =>
    parseDesignDocument({
      ...blankDesignDocument(),
      deletedSourceKeys: Array.from({ length: 5001 }, (_, index) => ({
        ...retained,
        sourceKey: `${index}`,
      })),
    }),
  ).toThrow();
  expect(() =>
    parseDesignDocument({ ...blankDesignDocument(), deletedSourceKeys: legacyHistory(10001) }),
  ).toThrow();
  expect(isWebCaptureImportKey(captureKey)).toBe(true);
  expect(isWebCaptureImportKey(duplicateKey)).toBe(true);
  for (const key of [
    "project:/page",
    "project:web-capture/custom-route",
    `${captureKey}#custom-copy`,
    `${duplicateKey}#extra`,
  ])
    expect(isWebCaptureImportKey(key)).toBe(false);
});

test("capture deletion supports undo, redo and a concurrent unrelated edit", () => {
  const before = parseDesignDocument({
    ...blankDesignDocument(),
    nodes: [
      ...captureNodes(20),
      {
        ...buildDrawnNode("other", "container", null, { x: 200, y: 0, width: 100, height: 100 }),
        importKey: "project:/page",
        sourceKey: "other",
      },
    ],
    deletedSourceKeys: [{ importKey: "project:/page", sourceKey: "previously-deleted" }],
  });
  const after = trackDocumentChanges(before, removeLayers(before, ["layer-0"]));
  const patch = diffDocument(before, after);
  const deleted = applyDocumentPatch(before, patch);
  const restored = applyDocumentPatch(deleted, invertPatch(patch), true);
  expect(restored).toEqual(before);
  expect(applyDocumentPatch(restored, patch, true)).toEqual(after);
  const remote = parseDesignDocument({
    ...before,
    nodes: before.nodes.map((node) =>
      node.id === "other" ? { ...node, name: "Remote edit" } : node,
    ),
  });
  const merged = applyDocumentPatch(remote, patch);
  expect(merged.nodes.map((node) => node.name)).toEqual(["Remote edit"]);
  expect(merged.deletedSourceKeys).toEqual(before.deletedSourceKeys);
  const allDeleted = trackDocumentChanges(merged, removeLayers(merged, ["other"]));
  expect(allDeleted.deletedSourceKeys).toContainEqual({
    importKey: "project:/page",
    sourceKey: "other",
  });
});

test("older clients' capture deletion patches are normalized on application", () => {
  const before = parseDesignDocument({ ...blankDesignDocument(), nodes: captureNodes(20) });
  const patch = diffDocument(before, {
    ...before,
    nodes: [],
    deletedSourceKeys: before.nodes.map((node) => ({
      importKey: node.importKey!,
      sourceKey: node.sourceKey!,
    })),
  });
  const after = applyDocumentPatch(before, patch);
  expect(after.nodes).toEqual([]);
  expect(after.deletedSourceKeys).toEqual([]);
});
