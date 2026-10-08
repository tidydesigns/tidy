import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode } from "./document";
import {
  copyLayers,
  copyProperties,
  pasteLayers,
  pasteProperties,
  readDesignClipboard,
} from "./clipboard";
import { relocateLayer, groupLayers } from "./document-operations";
import { rebaseDocument } from "./edit-queue";

const layer = (id, parentId = null) =>
  buildDrawnNode(id, "container", parentId, { x: 10, y: 20, width: 100, height: 50 });

test("layer copy deduplicates selected parents and paste creates an independent tree on the target page", () => {
  const source = { ...blankDesignDocument(), nodes: [layer("parent"), layer("child", "parent")] };
  const clipboard = readDesignClipboard(copyLayers(source, ["parent", "child"], "source"));
  expect(clipboard.nodes).toHaveLength(2);
  let id = 0;
  const target = { ...blankDesignDocument(), pages: [{ id: "target-page", name: "Target" }] };
  const pasted = pasteLayers(target, clipboard, {
    fileId: "target",
    pageId: "target-page",
    parentId: null,
    createId: () => `copy-${++id}`,
  });
  expect(pasted.ids).toEqual(["copy-1"]);
  expect(pasted.document.nodes[1].parentId).toBe("copy-1");
  expect(pasted.document.nodes.every((node) => node.pageId === "target-page")).toBe(true);
  expect(pasted.document.nodes[0].box.x).toBe(34);
});

test("paste in place preserves canvas position across pages and target frames", () => {
  const source = {
    ...blankDesignDocument(),
    nodes: [
      { ...layer("source-frame"), box: { x: 100, y: 200, width: 300, height: 300 } },
      { ...layer("nested", "source-frame"), box: { x: 30, y: 40, width: 50, height: 60 } },
    ],
  };
  const payload = readDesignClipboard(copyLayers(source, ["nested"], "source"));
  expect(payload.nodes[0].box).toMatchObject({ x: 130, y: 240 });
  const target = {
    ...blankDesignDocument(),
    pages: [{ id: "target-page", name: "Target" }],
    nodes: [
      {
        ...layer("target-frame"),
        pageId: "target-page",
        box: { x: 80, y: 90, width: 300, height: 300 },
      },
    ],
  };
  const pasted = pasteLayers(target, payload, {
    fileId: "target",
    pageId: "target-page",
    parentId: "target-frame",
    inPlace: true,
    createId: () => "pasted",
  });
  expect(pasted.document.nodes.at(-1)).toMatchObject({
    parentId: "target-frame",
    pageId: "target-page",
    box: { x: 50, y: 150 },
  });
});

test("paste rejects locked, inherited-hidden, or wrong-page target frames", () => {
  const source = { ...blankDesignDocument(), nodes: [layer("source")] };
  const payload = readDesignClipboard(copyLayers(source, ["source"], "source"));
  const target = {
    ...blankDesignDocument(),
    pages: [
      { id: "page-a", name: "A" },
      { id: "page-b", name: "B" },
    ],
    nodes: [
      { ...layer("locked"), pageId: "page-a", locked: true },
      { ...layer("hidden"), pageId: "page-a", visible: false },
      { ...layer("hidden-child", "hidden"), pageId: "page-a" },
      { ...layer("other-page"), pageId: "page-b" },
    ],
  };
  const options = { fileId: "target", pageId: "page-a", inPlace: true, createId: () => "pasted" };
  expect(() => pasteLayers(target, payload, { ...options, parentId: "locked" })).toThrow(
    "Unlock and show",
  );
  expect(() => pasteLayers(target, payload, { ...options, parentId: "hidden" })).toThrow(
    "Unlock and show",
  );
  expect(() => pasteLayers(target, payload, { ...options, parentId: "hidden-child" })).toThrow(
    "Unlock and show",
  );
  expect(() => pasteLayers(target, payload, { ...options, parentId: "other-page" })).toThrow(
    "this page",
  );
});

test("clipboard input rejects malformed, cyclic, and oversized content", () => {
  expect(readDesignClipboard("plain text")).toBeNull();
  const invalid = {
    bellaClipboard: 1,
    kind: "layers",
    sourceFile: "a",
    nodes: [{ ...layer("one", "two") }, layer("two", "one")],
  };
  expect(readDesignClipboard(JSON.stringify(invalid))).toBeNull();
  expect(readDesignClipboard("x".repeat(2_000_001))).toBeNull();
});

test("cross-file tokens preserve source colors without changing existing target tokens", () => {
  const source = {
    ...blankDesignDocument(),
    tokens: { brand: "#ff0000", unused: "#00ff00" },
    nodes: [{ ...layer("source"), style: { fillToken: "brand" } }],
  };
  const target = {
    ...blankDesignDocument(),
    tokens: { brand: "#0000ff" },
    nodes: [layer("target")],
  };
  const payload = readDesignClipboard(copyProperties(source.nodes[0], source, "source-file"));
  const pasted = pasteProperties(target, payload, ["target"]);
  expect(pasted.tokens).toEqual({ brand: "#0000ff", brand_2: "#ff0000" });
  expect(pasted.nodes[0].style.fillToken).toBe("brand_2");
});

test("appearance paste into only locked layers leaves the document and palette untouched", () => {
  const source = {
    ...blankDesignDocument(),
    tokens: { accent: "#ff0000" },
    nodes: [{ ...layer("source"), style: { fillToken: "accent" } }],
  };
  const target = { ...blankDesignDocument(), nodes: [{ ...layer("locked"), locked: true }] };
  const payload = readDesignClipboard(copyProperties(source.nodes[0], source, "source-file"));
  expect(pasteProperties(target, payload, ["locked"])).toBe(target);
});

test("property paste replaces appearance, respects ancestor locks, and keeps content and geometry", () => {
  const source = {
    ...blankDesignDocument(),
    nodes: [{ ...layer("source"), style: { radius: 16 } }],
  };
  const target = {
    ...blankDesignDocument(),
    nodes: [
      { ...layer("parent"), locked: true },
      { ...layer("locked-child", "parent"), style: { fill: "#ff0000" } },
      { ...layer("editable"), style: { fill: "#0000ff", radiusTopLeft: 5 } },
    ],
  };
  const payload = readDesignClipboard(copyProperties(source.nodes[0], source, "file"));
  const pasted = pasteProperties(target, payload, ["locked-child", "editable"]);
  expect(pasted.nodes[1].style.fill).toBe("#ff0000");
  expect(pasted.nodes[2].style.radius).toBe(16);
  expect(pasted.nodes[2].style.radiusTopLeft).toBeUndefined();
  expect(pasted.nodes[2].style.fill).toBeUndefined();
  expect(pasted.nodes[2].box).toEqual(target.nodes[2].box);
});

test("appearance transfer keeps target rotation, flips and box geometry", () => {
  const source = {
    ...blankDesignDocument(),
    nodes: [{ ...layer("source"), style: { rotation: 15, flipX: true, fill: "#ff0000" } }],
  };
  const target = {
    ...blankDesignDocument(),
    nodes: [{ ...layer("target"), style: { rotation: -37, flipY: true, fill: "#0000ff" } }],
  };
  const payload = readDesignClipboard(copyProperties(source.nodes[0], source, "source"));
  const result = pasteProperties(target, payload, ["target"]);
  expect(result.nodes[0].style).toMatchObject({ rotation: -37, flipY: true, fill: "#ff0000" });
  expect(result.nodes[0].style.flipX).toBeUndefined();
  expect(result.nodes[0].box).toEqual(target.nodes[0].box);
});

test("layer relocation preserves absolute position, ordering, and prevents descendant cycles", () => {
  const source = { ...blankDesignDocument(), nodes: [layer("a"), layer("b"), layer("child", "a")] };
  const nested = relocateLayer(source, "b", "a", "inside");
  expect(nested.nodes.find((node) => node.id === "b")).toMatchObject({
    parentId: "a",
    box: { x: 0, y: 0 },
  });
  expect(() => relocateLayer(nested, "a", "child", "inside")).toThrow("own children");
  expect(relocateLayer(source, "b", "a", "before").nodes[0].id).toBe("b");
});

test("group insertion keeps the intended stacking order when persisted", () => {
  const source = { ...blankDesignDocument(), nodes: [layer("a"), layer("b"), layer("c")] };
  const grouped = groupLayers(source, ["a", "b"], "group");
  expect(rebaseDocument(source, grouped, source).nodes[0].id).toBe("group");
});
