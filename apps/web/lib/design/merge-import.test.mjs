import { expect, test } from "bun:test";
import { buildLoginDocument } from "@/lib/design/examples/login";
import { mergeImport } from "@/lib/design/merge-import";
import { blankDesignDocument } from "@/lib/design/document";

const assetId = "00000000-0000-4000-8000-000000000001";

test("imports still work after the default page is removed", () => {
  const current = { ...blankDesignDocument(), pages: [{ id: "other-page", name: "Other page" }] };
  const incoming = buildLoginDocument(assetId);
  incoming.nodes = incoming.nodes.map((node) => ({ ...node, importKey: "bellarun:/login" }));
  const imported = mergeImport(current, incoming, "import");
  expect(imported.nodes.every((node) => node.pageId === "other-page")).toBe(true);
  expect(imported.pages).toEqual(current.pages);
});

test("reimport preserves stable layer IDs and manual edits when importer IDs change", () => {
  const original = buildLoginDocument(assetId);
  const key = "bellarun:/login";
  const current = {
    ...original,
    nodes: original.nodes.map((node) => ({
      ...node,
      importKey: key,
      text: node.id === "desktop-heading" ? "My heading" : node.text,
    })),
    editedNodeIds: ["desktop-heading"],
  };
  const incoming = {
    ...original,
    nodes: original.nodes.map((node) => ({
      ...node,
      id: `new-${node.id}`,
      parentId: node.parentId ? `new-${node.parentId}` : null,
      importKey: key,
      text: node.id === "desktop-heading" ? "Updated source heading" : node.text,
    })),
  };

  expect(() => mergeImport(current, incoming, "test-import")).toThrow(
    "Manually edited or deleted nodes need a resolution",
  );
  const kept = mergeImport(current, incoming, "test-import", "keep_user");
  expect(kept.nodes.find((node) => node.id === "desktop-heading")?.text).toBe("My heading");
  expect(kept.nodes.find((node) => node.id === "desktop-heading")?.parentId).toBe("desktop-panel");
  expect(kept.nodes.some((node) => node.id.startsWith("new-"))).toBe(false);
  expect(kept.editedNodeIds).toEqual(["desktop-heading"]);

  const replaced = mergeImport(current, incoming, "test-import", "use_import");
  expect(replaced.nodes.find((node) => node.id === "desktop-heading")?.text).toBe(
    "Updated source heading",
  );
  expect(replaced.editedNodeIds).toEqual([]);
});

test("reimport respects deleted imported layers until the user chooses source content", () => {
  const original = buildLoginDocument(assetId);
  const key = "bellarun:/login";
  const current = {
    ...original,
    nodes: original.nodes
      .filter((node) => node.id !== "desktop-description")
      .map((node) => ({ ...node, importKey: key })),
    deletedSourceKeys: [{ importKey: key, sourceKey: "desktop:description" }],
  };
  const incoming = {
    ...original,
    nodes: original.nodes.map((node) => ({ ...node, importKey: key })),
  };

  expect(() => mergeImport(current, incoming, "rerun")).toThrow("desktop:description");
  const kept = mergeImport(current, incoming, "rerun", "keep_user");
  expect(kept.nodes.some((node) => node.id === "desktop-description")).toBe(false);
  expect(kept.deletedSourceKeys).toHaveLength(1);
  const restored = mergeImport(current, incoming, "rerun", "use_import");
  expect(restored.nodes.some((node) => node.id === "desktop-description")).toBe(true);
  expect(restored.deletedSourceKeys).toHaveLength(0);
});

test("explicit page metadata keeps implicit reimport nodes on the source page", () => {
  const box = { x: 0, y: 0, width: 50, height: 50 };
  const current = blankDesignDocument();
  current.pages.push({ id: "existing-page", name: "Existing" });
  current.nodes = [
    {
      id: "old",
      name: "Old",
      type: "container",
      parentId: null,
      pageId: "existing-page",
      box,
      layout: "absolute",
      visible: true,
      locked: false,
      style: {},
      importKey: "project:/route",
      sourceKey: "root",
    },
  ];
  const incoming = blankDesignDocument();
  incoming.source = { project: "project", route: "/route" };
  incoming.pages = [...current.pages];
  incoming.nodes = [
    { ...current.nodes[0], id: "incoming", pageId: undefined },
    { ...current.nodes[0], id: "explicit", pageId: "page-1", sourceKey: "explicit" },
  ];
  const merged = mergeImport(current, incoming, "import", undefined, { preservePages: true });
  expect(merged.nodes.find((n) => n.id === "old").pageId).toBe("existing-page");
  expect(merged.nodes.find((n) => n.id === "explicit").pageId).toBe("page-1");
  expect(merged.pages).toEqual(current.pages);
});
