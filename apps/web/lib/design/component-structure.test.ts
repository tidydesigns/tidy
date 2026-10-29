import { test, expect } from "bun:test";
import {
  blankDesignDocument,
  buildDrawnNode,
  parseDesignDocument,
  type DesignDocument,
} from "./document";
import {
  createComponentInstance,
  makeComponent,
  removeLayers,
  moveLayer,
  reparentLayer,
} from "./document-operations";
import { editLayers, trackDocumentChanges } from "./edit-document";
import { editorErrorInstance, editorErrorNotice } from "./editor-error";
import { ComponentStructureError } from "./component-structure-error";
import { reconcileComponentStructure } from "./component-structure";
import {
  componentInstanceSources,
  owningInstance,
  resetInstance,
  detachInstance,
  swapInstance,
} from "./component-instance";
import { diffDocument, applyDocumentPatch, invertPatch } from "./document-patch";
import { resolveVariantNodes, standaloneVariants } from "./component-variants";
import { mergeImport } from "./merge-import";

const layer = (id: string, parentId: string | null = null) =>
  buildDrawnNode(id, "container", parentId, { x: 10, y: 20, width: 100, height: 50 });
function fixture() {
  const master = { ...layer("master"), importKey: "site:/", sourceKey: "master" };
  const child = {
    ...buildDrawnNode("label", "text", "master", { x: 5, y: 5, width: 80, height: 20 }),
    name: "Label",
    text: "Original",
    importKey: "site:/",
    sourceKey: "label",
  };
  const component = makeComponent(
    { ...blankDesignDocument(), nodes: [master, child, layer("other", "master")] },
    "master",
  );
  let id = 0;
  return createComponentInstance(component, "master", () => `copy-${id++}`).document;
}
const commit = (before: DesignDocument, after: DesignDocument) =>
  trackDocumentChanges(before, after);
const copyOf = (document: DesignDocument, source: string, root = "copy-0") => {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  return document.nodes.find((node) => {
    if (node.componentSourceId !== source) return false;
    let current = node;
    while (current.parentId && current.id !== root) current = byId.get(current.parentId)!;
    return current.id === root;
  })!;
};

test("master add/remove/reorder/reparent propagates with stable identities and one-step undo", () => {
  const before = fixture();
  const added = commit(before, { ...before, nodes: [...before.nodes, layer("new", "master")] });
  const copied = copyOf(added, "new");
  expect(copied.parentId).toBe("copy-0");
  expect(copied.importKey).toBeUndefined();
  const transported = JSON.parse(JSON.stringify(diffDocument(before, added)));
  expect(applyDocumentPatch(before, transported)).toEqual(added);
  expect(applyDocumentPatch(added, invertPatch(transported), true)).toEqual(
    parseDesignDocument(before),
  );
  const moved = commit(added, moveLayer(added, "new", -1));
  expect(
    moved.nodes.filter((node) => node.parentId === "copy-0").map((node) => node.componentSourceId),
  ).toEqual(["label", "new", "other"]);
  expect(copyOf(moved, "new").id).toBe(copied.id);
  const reparented = commit(moved, reparentLayer(moved, "new", "other"));
  expect(copyOf(reparented, "new").parentId).toBe(copyOf(reparented, "other").id);
  const deleted = commit(reparented, removeLayers(reparented, ["other"]));
  expect(deleted.nodes.some((node) => node.id === copied.id)).toBe(false);
  expect(deleted.nodes.some((node) => node.componentSourceId === "other")).toBe(false);
  expect(deleted.deletedSourceKeys).toEqual([]);
});

test("structure updates preserve property overrides and imported ownership", () => {
  const before = fixture();
  const overridden = commit(
    before,
    editLayers(before, ["copy-1"], { text: "Custom", style: { color: "#ff0000" } }),
  );
  const added = commit(overridden, {
    ...overridden,
    nodes: [...overridden.nodes, layer("new", "master")],
  });
  const edited = commit(
    added,
    editLayers(added, ["label"], { text: "Changed", style: { fontSize: 32 } }),
  );
  expect(copyOf(edited, "label")).toMatchObject({
    text: "Custom",
    style: { color: "#ff0000", fontSize: 32 },
  });
  expect(edited.editedNodeIds).toContain("label");
  expect(copyOf(edited, "new").sourceKey).toBeUndefined();
  const removed = commit(edited, removeLayers(edited, ["label"]));
  expect(removed.deletedSourceKeys).toContainEqual({ importKey: "site:/", sourceKey: "label" });
  expect(removed.nodes.some((node) => node.id === "copy-1")).toBe(false);
});

test("concurrent creation and independent additions reconcile deterministically", () => {
  const base = fixture();
  const a = commit(base, { ...base, nodes: [...base.nodes, layer("a", "master")] });
  const b = commit(base, { ...base, nodes: [...base.nodes, layer("b", "master")] });
  let id = 0;
  const remote = createComponentInstance(base, "master", () => `remote-${id++}`).document;
  const updated = applyDocumentPatch(remote, diffDocument(base, a));
  expect(copyOf(updated, "a", "remote-0")).toBeDefined();
  const together = applyDocumentPatch(updated, diffDocument(base, b));
  for (const root of ["copy-0", "remote-0"])
    for (const source of ["a", "b"]) expect(copyOf(together, source, root)).toBeDefined();
  expect(new Set(together.nodes.map((node) => node.id)).size).toBe(together.nodes.length);
});

test("a stale master patch preserves a newer explicit override and undo rejects conflicts", () => {
  const before = fixture();
  const master = commit(before, editLayers(before, ["label"], { text: "New master" }));
  const remote = commit(before, editLayers(before, ["copy-1"], { text: "Remote override" }));
  const result = applyDocumentPatch(remote, diffDocument(before, master));
  expect(copyOf(result, "label").text).toBe("Remote override");
  expect(result.nodes.find((node) => node.id === "label")!.text).toBe("New master");
  expect(() =>
    applyDocumentPatch(remote, invertPatch(diffDocument(before, master)), true),
  ).toThrow();
});

test("reset and detach are reversible and preserve root placement and selected variant appearance", () => {
  const base = fixture();
  const variant = parseDesignDocument({
    ...base,
    nodes: base.nodes.map((node) =>
      node.id === "master"
        ? {
            ...node,
            variants: {
              default: "primary",
              options: { primary: {}, secondary: { root: { style: { fill: "#ff0000" } } } },
            },
          }
        : node.id === "copy-0"
          ? { ...node, variant: "secondary" }
          : node,
    ),
  });
  const overridden = commit(variant, editLayers(variant, ["copy-1"], { text: "Override" }));
  const reset = commit(overridden, resetInstance(overridden, "copy-0"));
  expect(copyOf(reset, "label").text).toBe("Original");
  expect(reset.nodes.find((node) => node.id === "copy-0")!.box).toEqual(
    overridden.nodes.find((node) => node.id === "copy-0")!.box,
  );
  expect(applyDocumentPatch(reset, invertPatch(diffDocument(overridden, reset)), true)).toEqual(
    overridden,
  );
  const detached = commit(overridden, detachInstance(overridden, "copy-0"));
  expect(detached.nodes.find((node) => node.id === "copy-0")!.style.fill).toBe("#ff0000");
  expect(detached.nodes.find((node) => node.id === "copy-1")!.instanceOf).toBeUndefined();
  expect(
    applyDocumentPatch(detached, invertPatch(diffDocument(overridden, detached)), true),
  ).toEqual(overridden);
});

test("swap retains placement and compatible uniquely matched overrides; undo restores the old family", () => {
  const base = fixture();
  const other = makeComponent(
    {
      ...base,
      nodes: [
        ...base.nodes,
        layer("target"),
        {
          ...buildDrawnNode("target-label", "text", "target", {
            x: 0,
            y: 0,
            width: 60,
            height: 20,
          }),
          name: "Label",
          text: "Target",
        },
      ],
    },
    "target",
  );
  const before = commit(other, editLayers(other, ["copy-1"], { text: "Custom" }));
  const swapped = commit(before, swapInstance(before, "copy-0", "target"));
  expect(swapped.nodes.find((node) => node.id === "copy-0")!.instanceOf).toBe("target");
  expect(copyOf(swapped, "target-label").text).toBe("Custom");
  expect(swapped.nodes.some((node) => node.id === "copy-1")).toBe(false);
  expect(applyDocumentPatch(swapped, invertPatch(diffDocument(before, swapped)), true)).toEqual(
    before,
  );
});

test("nested instance structure, properties and variants propagate through source chains", () => {
  let document = fixture();
  document = makeComponent({ ...document, nodes: [...document.nodes, layer("outer")] }, "outer");
  document = commit(document, reparentLayer(document, "copy-0", "outer"));
  let id = 0;
  document = createComponentInstance(document, "outer", () => `outer-copy-${id++}`).document;
  const added = commit(document, {
    ...document,
    nodes: [...document.nodes, layer("new", "master")],
  });
  const nestedChild = copyOf(added, "new");
  expect(copyOf(added, nestedChild.id, "outer-copy-0")).toBeDefined();
  const edited = commit(added, editLayers(added, ["label"], { text: "Nested change" }));
  expect(copyOf(edited, "copy-1", "outer-copy-0").text).toBe("Nested change");
  const variant = parseDesignDocument({
    ...edited,
    nodes: edited.nodes.map((node) =>
      node.id === "master"
        ? {
            ...node,
            variants: {
              default: "default",
              options: { default: { children: { label: { style: { color: "#ff0000" } } } } },
            },
          }
        : node,
    ),
  });
  expect(
    resolveVariantNodes(variant.nodes).find(
      (node) => node.id === copyOf(variant, "copy-1", "outer-copy-0").id,
    )!.style.color,
  ).toBe("#ff0000");
  expect(() =>
    reconcileComponentStructure(document.nodes, reparentLayer(document, "copy-0", "master").nodes),
  ).toThrow();
});

test("linked child structure requires detach, with no silent loss of local edits", () => {
  const before = fixture();
  expect(() =>
    commit(before, { ...before, nodes: [...before.nodes, layer("local", "copy-0")] }),
  ).toThrow("Detach");
  expect(() => commit(before, removeLayers(before, ["copy-1"]))).toThrow("Detach");
  expect(() => commit(before, moveLayer(before, "copy-1", 1))).toThrow("Detach");
  const detached = detachInstance(before, "copy-0");
  expect(() =>
    commit(detached, { ...detached, nodes: [...detached.nodes, layer("local", "copy-0")] }),
  ).not.toThrow();
});

test("stale detach and master deletion freeze the latest overridden appearance", () => {
  const before = fixture();
  const detached = commit(before, detachInstance(before, "copy-0"));
  const remote = commit(
    before,
    editLayers(before, ["copy-1"], { text: "Later override", style: { color: "#ff0000" } }),
  );
  const result = applyDocumentPatch(remote, diffDocument(before, detached));
  expect(result.nodes.find((node) => node.id === "copy-1")).toMatchObject({
    text: "Later override",
    style: { color: "#ff0000" },
  });
  expect(result.nodes.find((node) => node.id === "copy-1")!.instanceOf).toBeUndefined();
  const deleted = commit(before, removeLayers(before, ["master"]));
  const latest = applyDocumentPatch(remote, diffDocument(before, deleted));
  expect(latest.nodes.find((node) => node.id === "copy-1")!.text).toBe("Later override");
});

test("nested explicit overrides survive inner-family variants and outer propagation", () => {
  let document = fixture();
  document = commit(document, editLayers(document, ["copy-1"], { style: { color: "#0000ff" } }));
  document = makeComponent({ ...document, nodes: [...document.nodes, layer("outer")] }, "outer");
  document = commit(document, reparentLayer(document, "copy-0", "outer"));
  document = parseDesignDocument({
    ...document,
    nodes: document.nodes.map((node) =>
      node.id === "master"
        ? {
            ...node,
            variants: {
              default: "selected",
              options: { selected: { children: { label: { style: { color: "#ff0000" } } } } },
            },
          }
        : node.id === "copy-0"
          ? { ...node, variant: "selected" }
          : node,
    ),
  });
  let id = 0;
  const nested = createComponentInstance(document, "outer", () => `nested-${id++}`).document;
  const target = copyOf(nested, "copy-1", "nested-0");
  expect(resolveVariantNodes(nested.nodes).find((node) => node.id === target.id)!.style.color).toBe(
    "#0000ff",
  );
  const nestedRoot = copyOf(nested, "copy-0", "nested-0");
  const exported = standaloneVariants(nested.nodes, nestedRoot);
  expect(exported?.options.selected.children?.[target.id]?.style?.color).toBeUndefined();
  expect(exported?.default).toBe("selected");
});

test("reimported master structure updates local instances without stealing import ownership", () => {
  const base = fixture();
  const before = commit(base, editLayers(base, ["copy-1"], { text: "Local override" }));
  const incoming = parseDesignDocument({
    ...blankDesignDocument(),
    source: { project: "site", route: "/" },
    nodes: [
      { ...layer("new-master"), isComponent: true, importKey: "site:/", sourceKey: "master" },
      {
        ...buildDrawnNode("new-label", "text", "new-master", { x: 0, y: 0, width: 90, height: 20 }),
        text: "Imported",
        importKey: "site:/",
        sourceKey: "label",
      },
      { ...layer("new-child", "new-master"), importKey: "site:/", sourceKey: "added" },
    ],
  });
  const result = mergeImport(before, incoming, "import", "use_import");
  expect(copyOf(result, "label").text).toBe("Local override");
  expect(copyOf(result, "new-child")).toBeDefined();
  expect(copyOf(result, "new-child").importKey).toBeUndefined();
  expect(copyOf(result, "new-child").sourceKey).toBeUndefined();
});

test("property refresh preserves canonical instance node identities and order", () => {
  const before = fixture();
  const synced = editLayers(before, ["label"], { text: "Shared label" });
  const normalized = reconcileComponentStructure(before.nodes, synced.nodes);
  const again = reconcileComponentStructure(normalized, normalized);
  expect(again).toEqual(normalized);
  expect(again.every((node, index) => node === normalized[index])).toBe(true);
  expect(again.filter((node) => node.type === "text").map((node) => node.text)).toEqual([
    "Shared label",
    "Shared label",
  ]);
});

test("indexed refresh canonicalizes interleaved children without losing unrelated siblings", () => {
  const original = fixture();
  const canonical = reconcileComponentStructure(original.nodes, original.nodes);
  const root = canonical.find((node) => node.id === "copy-0")!;
  const children = canonical.filter((node) => node.parentId === root.id);
  const unrelated = layer("unrelated");
  const scattered = [
    ...canonical.filter((node) => !children.includes(node)),
    unrelated,
    ...children,
  ];
  const normalized = reconcileComponentStructure(scattered, scattered);
  const position = normalized.findIndex((node) => node.id === root.id);
  expect(normalized.slice(position, position + children.length + 1).map((node) => node.id)).toEqual(
    [root.id, ...children.map((node) => node.id)],
  );
  expect(normalized.filter((node) => node.id === "unrelated")).toEqual([unrelated]);
  expect(new Set(normalized.map((node) => node.id)).size).toBe(scattered.length);
});

test("property propagation leaves input snapshots intact across multiple and nested instances", () => {
  let document = fixture();
  let id = 0;
  document = createComponentInstance(document, "master", () => `second-${id++}`).document;
  document = makeComponent({ ...document, nodes: [...document.nodes, layer("outer")] }, "outer");
  document = commit(document, reparentLayer(document, "copy-0", "outer"));
  document = createComponentInstance(document, "outer", () => `nested-${id++}`).document;
  const before = parseDesignDocument(document);
  const input = {
    ...before,
    nodes: before.nodes.map((node) =>
      node.id === "label" ? { ...node, text: "Updated master" } : node,
    ),
  };
  const savedBefore = structuredClone(before);
  const savedInput = structuredClone(input);
  // Freeze caller-owned arrays and values to catch accidental writes during the
  // in-place optimization of the reconciler's private working array.
  for (const snapshot of [before, input]) {
    Object.freeze(snapshot.nodes);
    for (const node of snapshot.nodes) Object.freeze(node);
  }
  const result = reconcileComponentStructure(before.nodes, input.nodes);
  expect(before).toEqual(savedBefore);
  expect(input).toEqual(savedInput);
  expect(result).not.toBe(input.nodes);
  expect(result.filter((node) => node.type === "text").map((node) => node.text)).toEqual([
    "Updated master",
    "Updated master",
    "Updated master",
    "Updated master",
  ]);
  expect(parseDesignDocument({ ...before, nodes: result }).nodes).toHaveLength(result.length);
});

test("master structure edits remain usable in imported documents over 5000 layers", () => {
  const base = fixture();
  const before = parseDesignDocument({
    ...base,
    nodes: [
      ...base.nodes,
      ...Array.from({ length: 6000 - base.nodes.length }, (_, index) => layer(`filler-${index}`)),
    ],
  });
  const after = commit(before, {
    ...before,
    nodes: [...before.nodes, layer("imported-child", "master")],
  });
  expect(after.nodes).toHaveLength(6002);
  expect(copyOf(after, "imported-child").parentId).toBe("copy-0");
  expect(applyDocumentPatch(after, invertPatch(diffDocument(before, after)), true)).toEqual(before);
});

test("instance controls resolve the selected child's own copy, not another copy or the master", () => {
  const before = fixture();
  let id = 0;
  const document = createComponentInstance(before, "master", () => `second-${id++}`).document;
  expect(owningInstance(document.nodes, "copy-1")?.id).toBe("copy-0");
  expect(owningInstance(document.nodes, "second-1")?.id).toBe("second-0");
  expect(owningInstance(document.nodes, "copy-0")?.id).toBe("copy-0");
  expect(owningInstance(document.nodes, "label")).toBeUndefined();
  expect(owningInstance(document.nodes, "missing")).toBeUndefined();
  const detached = detachInstance(document, "copy-0");
  expect(owningInstance(detached.nodes, "copy-1")).toBeUndefined();
});

test("linked text can be cleared; explicit detach enables deletion and both actions undo", () => {
  const before = fixture();
  const cleared = commit(before, editLayers(before, ["copy-1"], { text: "" }));
  expect(cleared.nodes.find((node) => node.id === "copy-1")?.text).toBe("");
  expect(cleared.nodes.find((node) => node.id === "label")?.text).toBe("Original");
  const owner = owningInstance(cleared.nodes, "copy-1")!;
  const detached = commit(cleared, detachInstance(cleared, owner.id));
  const deleted = commit(detached, removeLayers(detached, ["copy-1"]));
  expect(deleted.nodes.some((node) => node.id === "copy-1")).toBe(false);
  expect(deleted.nodes.find((node) => node.id === "label")?.text).toBe("Original");
  const restored = applyDocumentPatch(deleted, invertPatch(diffDocument(detached, deleted)), true);
  expect(restored).toEqual(detached);
  expect(applyDocumentPatch(restored, invertPatch(diffDocument(cleared, detached)), true)).toEqual(
    cleared,
  );
});

test("structure warnings retain the blocked instance and reject stale detach targets", () => {
  const before = fixture();
  let id = 0;
  const document = createComponentInstance(before, "master", () => `second-${id++}`).document;
  let failure: unknown;
  try {
    commit(document, removeLayers(document, ["second-1"]));
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ComponentStructureError);
  const notice = editorErrorNotice(failure, "Could not change layers.");
  expect(notice.detach).toEqual({ instanceId: "second-0", componentId: "master" });
  expect(editorErrorInstance(document, notice)?.id).toBe("second-0");
  const detached = commit(
    document,
    detachInstance(document, editorErrorInstance(document, notice)!.id),
  );
  expect(detached.nodes.find((node) => node.id === "copy-0")?.instanceOf).toBe("master");
  expect(editorErrorInstance(detached, notice)).toBeUndefined();
  expect(editorErrorInstance(removeLayers(document, ["second-0"]), notice)).toBeUndefined();
  const locked = {
    ...document,
    nodes: document.nodes.map((node) =>
      node.id === "second-0" ? { ...node, locked: true } : node,
    ),
  };
  expect(editorErrorInstance(locked, notice)).toBeUndefined();
  const swapped = {
    ...document,
    nodes: document.nodes.map((node) =>
      node.id === "second-0"
        ? { ...node, instanceOf: "other-component", componentSourceId: "other-component" }
        : node,
    ),
  };
  expect(editorErrorInstance(swapped, notice)).toBeUndefined();
  expect(
    editorErrorInstance(document, editorErrorNotice(new Error("Other error"), "Failed")),
  ).toBeUndefined();
});

test("component choices exclude owning ancestors and include unrelated sources on other pages", () => {
  const document = fixture();
  const nodes = [
    { ...layer("ancestor"), isComponent: true },
    ...document.nodes.map((node) =>
      node.id === "copy-0" ? { ...node, parentId: "ancestor" } : node,
    ),
    { ...layer("remote-source"), isComponent: true, pageId: "page-2" },
  ];
  expect(componentInstanceSources(nodes, "copy-0").map((node) => node.id)).toEqual([
    "master",
    "remote-source",
  ]);
  const moved = nodes.map((node) => (node.id === "copy-0" ? { ...node, parentId: null } : node));
  expect(componentInstanceSources(moved, "copy-0").map((node) => node.id)).toEqual([
    "ancestor",
    "master",
    "remote-source",
  ]);
  expect(owningInstance(moved, "copy-1")?.id).toBe("copy-0");
  const detached = moved.map((node) =>
    node.id.startsWith("copy-")
      ? { ...node, instanceOf: undefined, componentSourceId: undefined }
      : node,
  );
  expect(owningInstance(detached, "copy-1")).toBeUndefined();
});

test("instance recovery respects ancestor locks and rejects stale metadata", () => {
  const document = fixture();
  const notice = editorErrorNotice(
    new ComponentStructureError("Detach", "copy-0", "master"),
    "Failed",
  );
  const locked = {
    ...document,
    nodes: [
      { ...layer("locked-parent"), locked: true },
      ...document.nodes.map((node) =>
        node.id === "copy-0" ? { ...node, parentId: "locked-parent" } : node,
      ),
    ],
  };
  expect(editorErrorInstance(locked, notice)).toBeUndefined();
  expect(() => detachInstance(locked, "copy-0")).toThrow("unlocked");
  const altered = {
    ...document,
    nodes: document.nodes.map((node) =>
      node.id === "copy-0" ? { ...node, componentSourceId: "label" } : node,
    ),
  };
  expect(editorErrorInstance(altered, notice)).toBeUndefined();
});
