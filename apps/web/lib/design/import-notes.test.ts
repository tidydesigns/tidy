import { expect, test } from "bun:test";
import {
  blankDesignDocument,
  buildDrawnNode,
  parseDesignDocument,
  type DesignDocument,
} from "./document";
import { importNoteKey, importNotes, setImportNoteStatus, type ImportNote } from "./import-notes";
import { mergeImport } from "./merge-import";
import { applyDocumentPatch, diffDocument, invertPatch } from "./document-patch";

function fixture(warnings: ImportNote[], id = "frame"): DesignDocument {
  return {
    ...blankDesignDocument(),
    source: { project: "site", route: "/" },
    warnings,
    nodes: [
      {
        ...buildDrawnNode(id, "artboard", null, { x: 0, y: 0, width: 100, height: 100 }),
        importKey: "site:/",
        sourceKey: "frame",
      },
    ],
  };
}

test("legacy duplicates collapse and read/dismiss/restore states survive serialization and patches", () => {
  const initial = fixture([
    { message: "Static interactions" },
    { message: " Static  interactions " },
  ]);
  expect(importNotes(initial)).toHaveLength(1);
  const key = importNoteKey(importNotes(initial)[0]);
  let current = initial;
  for (const status of ["read", "dismissed", "read"] as const) {
    const changed = setImportNoteStatus(current, key, status);
    current = parseDesignDocument(
      JSON.parse(JSON.stringify(applyDocumentPatch(current, diffDocument(current, changed)))),
    );
    expect(current.warnings).toHaveLength(1);
    expect(current.warnings[0].status).toBe(status);
  }
});

test("reimports preserve acknowledgements across regenerated layer IDs and retire only their own obsolete notes", () => {
  const current = fixture([
    { message: "Static interactions", status: "read" },
    { nodeId: "frame", message: "Font unavailable", status: "dismissed" },
    { message: "Old limitation" },
    { message: "Another source", importKey: "other:/", status: "dismissed" },
  ]);
  const incoming = fixture(
    [
      { message: " Static  interactions " },
      { nodeId: "new-frame", message: "Font unavailable" },
      { message: "New limitation", status: "dismissed" },
    ],
    "new-frame",
  );
  const merged = mergeImport(current, incoming, "rerun");
  expect(merged.warnings).toHaveLength(4);
  expect(merged.warnings.find((note) => note.message.trim().startsWith("Static"))?.status).toBe(
    "read",
  );
  expect(merged.warnings.find((note) => note.message === "Font unavailable")).toMatchObject({
    nodeId: "frame",
    status: "dismissed",
  });
  expect(merged.warnings.find((note) => note.message === "New limitation")?.status).toBe("unread");
  expect(merged.warnings.find((note) => note.message === "Another source")?.status).toBe(
    "dismissed",
  );
  const resolved = mergeImport(merged, fixture([]), "resolved");
  expect(resolved.warnings.map((note) => note.message)).toEqual(["Another source"]);
});

test("changed messages start unread; unchanged dismissed messages stay hidden on repeated imports", () => {
  const current = fixture([{ message: "Static interactions", status: "dismissed" }]);
  const repeated = mergeImport(
    current,
    fixture([{ message: "Static interactions" }, { message: "Static interactions" }]),
    "repeat",
  );
  expect(repeated.warnings).toHaveLength(1);
  expect(repeated.warnings[0].status).toBe("dismissed");
  const changed = mergeImport(
    repeated,
    fixture([{ message: "Animations and interactions are static" }]),
    "changed",
  );
  expect(changed.warnings).toHaveLength(1);
  expect(changed.warnings[0].status).toBe("unread");
});

test("new and duplicate imports start unread and duplicate notes target copied layers", () => {
  const original = fixture([{ nodeId: "frame", message: "Static", status: "dismissed" }]);
  const first = mergeImport(null, original, "first");
  expect(first.warnings[0].status).toBe("unread");
  const duplicated = mergeImport(original, original, "copy", "duplicate");
  expect(duplicated.warnings).toHaveLength(2);
  expect(duplicated.warnings[0].status).toBe("dismissed");
  expect(duplicated.warnings[1]).toMatchObject({
    nodeId: "copy-frame",
    importKey: "site:/#copy",
    status: "unread",
  });
});

test("concurrent acknowledgements of different notes survive and undo affects only its note", () => {
  const base = fixture([{ message: "First" }, { message: "Second" }]);
  const [first, second] = importNotes(base).map(importNoteKey);
  const a = diffDocument(base, setImportNoteStatus(base, first, "read"));
  const b = diffDocument(base, setImportNoteStatus(base, second, "dismissed"));
  for (const patches of [
    [a, b],
    [b, a],
  ]) {
    const merged = patches.reduce((doc, patch) => applyDocumentPatch(doc, patch), base);
    expect(merged.warnings.map((note) => note.status)).toEqual(["read", "dismissed"]);
    const undone = applyDocumentPatch(merged, invertPatch(a), true);
    expect(undone.warnings.map((note) => note.status)).toEqual([undefined, "dismissed"]);
  }
});

test("late acknowledgement cannot bring back a retired note", () => {
  const base = fixture([{ message: "Resolved" }]);
  const patch = diffDocument(
    base,
    setImportNoteStatus(base, importNoteKey(importNotes(base)[0]), "read"),
  );
  const resolved = mergeImport(base, fixture([]), "resolved");
  expect(applyDocumentPatch(resolved, patch).warnings).toEqual([]);
});

test("unattributed legacy notes are preserved when a source is imported", () => {
  const base = { ...blankDesignDocument(), warnings: [{ message: "Unattributed" }] };
  const merged = mergeImport(base, fixture([]), "new");
  expect(merged.warnings.map((note) => note.message)).toEqual(["Unattributed"]);
  expect(mergeImport(merged, fixture([]), "again").warnings.map((note) => note.message)).toEqual([
    "Unattributed",
  ]);
});
