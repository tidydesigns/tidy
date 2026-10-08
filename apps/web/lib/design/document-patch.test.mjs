import { describe, test, expect } from "bun:test";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { applyDocumentPatch, diffDocument, invertPatch } from "./document-patch";
import { groupLayers, removeLayers } from "./document-operations";
import { importNoteKey, importNotes, setImportNoteStatus } from "./import-notes";
import { removeColorToken } from "./tokens";
import { trackDocumentChanges } from "./edit-document";

// JSONB does not preserve object key order across storage and transport.
const stored = (value) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => b.localeCompare(a)))
        : item,
    ),
  );
const node = (id, x = 10) =>
  buildDrawnNode(id, "container", null, { x, y: 20, width: 100, height: 80 });
const fixture = () => ({ ...blankDesignDocument(), nodes: [node("a"), node("b", 200)] });
const change = (doc, id, transform) => ({
  ...doc,
  nodes: doc.nodes.map((n) => (n.id === id ? transform(n) : n)),
});
describe("multiplayer document patches", () => {
  test("independent concurrent node edits survive in either order", () => {
    const base = fixture();
    const a = diffDocument(
      base,
      change(base, "a", (n) => ({ ...n, name: "A" })),
    );
    const b = diffDocument(
      base,
      change(base, "b", (n) => ({ ...n, name: "B" })),
    );
    for (const patches of [
      [a, b],
      [b, a],
    ])
      expect(
        patches
          .reduce((doc, patch) => applyDocumentPatch(doc, patch), base)
          .nodes.map((n) => n.name),
      ).toEqual(["A", "B"]);
  });
  test("same node, different nested properties merge", () => {
    const base = fixture();
    const move = diffDocument(
      base,
      change(base, "a", (n) => ({ ...n, box: { ...n.box, x: 75 } })),
    );
    const resize = diffDocument(
      base,
      change(base, "a", (n) => ({ ...n, box: { ...n.box, width: 250 } })),
    );
    expect(applyDocumentPatch(applyDocumentPatch(base, move), resize).nodes[0].box).toEqual({
      x: 75,
      y: 20,
      width: 250,
      height: 80,
    });
  });
  test("same scalar property follows accepted server order", () => {
    const base = fixture();
    const a = diffDocument(
      base,
      change(base, "a", (n) => ({ ...n, name: "First" })),
    );
    const b = diffDocument(
      base,
      change(base, "a", (n) => ({ ...n, name: "Second" })),
    );
    expect(applyDocumentPatch(applyDocumentPatch(base, a), b).nodes[0].name).toBe("Second");
  });
  test("a stale property edit cannot resurrect a deleted layer", () => {
    const base = fixture();
    const edit = diffDocument(
      base,
      change(base, "a", (n) => ({ ...n, name: "Changed" })),
    );
    const deleted = applyDocumentPatch(base, diffDocument(base, removeLayers(base, ["a"])));
    expect(() => applyDocumentPatch(deleted, edit)).toThrow("deleted elsewhere");
  });
  test("undo preserves other collaborators' node and property edits", () => {
    const base = fixture();
    const local = diffDocument(
      base,
      change(base, "a", (n) => ({ ...n, box: { ...n.box, x: 40 } })),
    );
    const after = applyDocumentPatch(base, local);
    const remote = diffDocument(
      base,
      change(base, "a", (n) => ({ ...n, box: { ...n.box, width: 300 } })),
    );
    const concurrent = applyDocumentPatch(after, remote);
    expect(applyDocumentPatch(concurrent, invertPatch(local), true).nodes[0].box).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 80,
    });
  });
  test("undo refuses to overwrite a newer edit to the same property", () => {
    const base = fixture();
    const local = diffDocument(
      base,
      change(base, "a", (n) => ({ ...n, name: "Local" })),
    );
    const after = applyDocumentPatch(base, local);
    const remote = diffDocument(
      base,
      change(base, "a", (n) => ({ ...n, name: "Remote" })),
    );
    expect(() =>
      applyDocumentPatch(applyDocumentPatch(after, remote), invertPatch(local), true),
    ).toThrow("cannot be undone");
  });
  test("concurrent creations keep both stable IDs", () => {
    const base = fixture();
    const a = diffDocument(base, { ...base, nodes: [...base.nodes, node("new-a")] });
    const b = diffDocument(base, { ...base, nodes: [...base.nodes, node("new-b")] });
    expect(applyDocumentPatch(applyDocumentPatch(base, a), b).nodes.map((n) => n.id)).toContain(
      "new-a",
    );
    expect(applyDocumentPatch(applyDocumentPatch(base, a), b).nodes.map((n) => n.id)).toContain(
      "new-b",
    );
  });
  test("undoing a creation preserves an unrelated remote creation", () => {
    const base = fixture();
    const local = diffDocument(base, { ...base, nodes: [...base.nodes, node("local")] });
    const remote = diffDocument(base, { ...base, nodes: [...base.nodes, node("remote")] });
    const both = applyDocumentPatch(applyDocumentPatch(base, local), remote);
    expect(applyDocumentPatch(both, invertPatch(local), true).nodes.map((n) => n.id)).toEqual([
      "a",
      "b",
      "remote",
    ]);
  });
  test("grouping is atomic and undo restores the previous tree", () => {
    const base = fixture();
    const patch = diffDocument(base, groupLayers(base, ["a", "b"], "group"));
    const grouped = applyDocumentPatch(base, patch);
    expect(grouped.nodes.find((n) => n.id === "a").parentId).toBe("group");
    expect(applyDocumentPatch(grouped, invertPatch(patch), true)).toEqual(base);
  });
  test("deleting a parent with a new remote child rejects the stale operation", () => {
    const parent = { ...node("parent"), type: "artboard" };
    const base = { ...blankDesignDocument(), nodes: [parent] };
    const child = { ...node("child"), parentId: "parent" };
    const remote = applyDocumentPatch(
      base,
      diffDocument(base, { ...base, nodes: [parent, child] }),
    );
    expect(() => applyDocumentPatch(remote, diffDocument(base, { ...base, nodes: [] }))).toThrow(
      "has no parent",
    );
  });
  test("JSON transport preserves removing optional style properties", () => {
    const base = fixture();
    base.nodes[0].style.fillToken = "brand";
    base.tokens.brand = "#ff0000";
    const next = change(base, "a", (n) => ({
      ...n,
      style: { ...n.style, fillToken: undefined, fill: "#ffffff" },
    }));
    const patch = JSON.parse(JSON.stringify(diffDocument(base, next)));
    expect(applyDocumentPatch(base, patch).nodes[0].style).toEqual({ fill: "#ffffff" });
  });
  test("cannot patch identity, prototypes, or comment ownership", () => {
    const base = fixture();
    for (const path of [["__proto__", "x"], ["commentPages", "a"], ["schemaVersion"]])
      expect(() =>
        applyDocumentPatch(base, [
          {
            collection: "document",
            path,
            before: { exists: false },
            after: { exists: true, value: 1 },
          },
        ]),
      ).toThrow();
  });
});

test("undo on imported layers preserves another editor's bookkeeping", () => {
  const base = fixture();
  base.nodes = base.nodes.map((node) => ({ ...node, importKey: "project:/", sourceKey: node.id }));
  const localAfter = {
    ...change(base, "a", (node) => ({ ...node, name: "Local" })),
    editedNodeIds: ["a"],
  };
  const remoteAfter = {
    ...change(base, "b", (node) => ({ ...node, name: "Remote" })),
    editedNodeIds: ["b"],
  };
  const local = diffDocument(base, localAfter);
  const both = applyDocumentPatch(applyDocumentPatch(base, local), diffDocument(base, remoteAfter));
  const undone = applyDocumentPatch(both, invertPatch(local), true);
  expect(undone.nodes[0].name).toBe("Rectangle");
  expect(undone.nodes[1].name).toBe("Remote");
  expect(undone.editedNodeIds).toContain("b");
});

test("marking an import note read does not contaminate token deletion history after JSONB storage", () => {
  let current = stored({
    ...fixture(),
    tokens: { brand: "#ff0000" },
    warnings: [
      { message: "Static interactions", importKey: "site:/" },
      { message: "Font unavailable", importKey: "site:/" },
    ],
  });
  const noteKey = importNoteKey(importNotes(current)[0]);
  const read = diffDocument(
    current,
    trackDocumentChanges(current, setImportNoteStatus(current, noteKey, "read")),
  );
  current = stored(applyDocumentPatch(current, read));
  const deletion = diffDocument(
    current,
    trackDocumentChanges(current, removeColorToken(current, "brand")),
  );
  const deleted = applyDocumentPatch(current, deletion);
  const canonical = diffDocument(current, deleted);
  expect(canonical.some((change) => change.path[0] === "warnings")).toBe(false);
  const restored = applyDocumentPatch(stored(deleted), invertPatch(canonical), true);
  expect(restored.tokens.brand).toBe("#ff0000");
  expect(restored.warnings.find((note) => importNoteKey(note) === noteKey).status).toBe("read");
});

test("undo and redo of layer deletion tolerate reordered nested object keys", () => {
  const base = parseDesignDocument(fixture());
  const patch = diffDocument(base, removeLayers(base, ["a"]));
  const deleted = stored(applyDocumentPatch(stored(base), patch));
  const restored = applyDocumentPatch(deleted, invertPatch(patch), true);
  expect(restored).toEqual(base);
  expect(applyDocumentPatch(stored(restored), patch, true)).toEqual(
    parseDesignDocument(removeLayers(base, ["a"])),
  );
});

test("undo of an import note acknowledgement tolerates reordered object keys but rejects a changed status", () => {
  const base = parseDesignDocument({
    ...fixture(),
    warnings: [{ nodeId: "a", message: "Static", importKey: "site:/" }],
  });
  const key = importNoteKey(importNotes(base)[0]);
  const patch = diffDocument(base, setImportNoteStatus(base, key, "read"));
  const read = stored(applyDocumentPatch(stored(base), patch));
  expect(applyDocumentPatch(read, invertPatch(patch), true).warnings[0].status).toBeUndefined();
  const dismissed = setImportNoteStatus(read, key, "dismissed");
  expect(() => applyDocumentPatch(dismissed, invertPatch(patch), true)).toThrow("cannot be undone");
});

test("undoing an imported layer deletion removes its stored deletion marker", () => {
  const base = parseDesignDocument({
    ...fixture(),
    nodes: fixture().nodes.map((node) => ({ ...node, importKey: "site:/", sourceKey: node.id })),
  });
  const patch = diffDocument(base, trackDocumentChanges(base, removeLayers(base, ["a"])));
  const deleted = stored(applyDocumentPatch(base, patch));
  expect(deleted.deletedSourceKeys).toHaveLength(1);
  const restored = applyDocumentPatch(deleted, invertPatch(patch), true);
  expect(restored.nodes.map((node) => node.id)).toEqual(["a", "b"]);
  expect(restored.deletedSourceKeys).toEqual([]);
});

test("validation key reordering does not mark untouched imported layers as manually edited", () => {
  const base = stored({
    ...fixture(),
    nodes: fixture().nodes.map((node) => ({ ...node, importKey: "site:/", sourceKey: node.id })),
  });
  const after = trackDocumentChanges(
    base,
    parseDesignDocument({ ...base, tokens: { brand: "#ffffff" } }),
  );
  expect(after.editedNodeIds).toEqual([]);
  const edited = trackDocumentChanges(
    base,
    change(after, "a", (node) => ({ ...node, name: "Manual" })),
  );
  expect(edited.editedNodeIds).toEqual(["a"]);
});
