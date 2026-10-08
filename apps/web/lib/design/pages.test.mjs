import { describe, expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { deletePage, duplicatePage, pageNodes } from "./pages";
import { groupLayers, moveLayer } from "./document-operations";

describe("file pages", () => {
  test("older documents open on Page 1", () => {
    const old = blankDesignDocument();
    delete old.pages;
    old.nodes = [
      buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 200, height: 200 }),
    ];
    const document = parseDesignDocument(old);
    expect(document.pages).toEqual([{ id: "page-1", name: "Page 1" }]);
    expect(pageNodes(document, "page-1")).toHaveLength(1);
  });

  test("each page owns its layer tree and duplicate remaps descendants", () => {
    const document = blankDesignDocument();
    document.nodes = [
      buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 200, height: 200 }),
      buildDrawnNode("text", "text", "frame", { x: 10, y: 10, width: 80, height: 20 }),
    ];
    const copy = parseDesignDocument(
      duplicatePage(
        document,
        "page-1",
        "page-2",
        (() => {
          let id = 0;
          return () => `copy-${++id}`;
        })(),
      ),
    );
    expect(pageNodes(copy, "page-2").map((node) => node.id)).toEqual(["copy-1", "copy-2"]);
    expect(pageNodes(copy, "page-2")[1].parentId).toBe("copy-1");
    const withoutFirst = parseDesignDocument(deletePage(copy, "page-1"));
    expect(withoutFirst.pages).toEqual([{ id: "page-2", name: "Page 1 copy" }]);
    expect(withoutFirst.nodes.map((node) => node.id)).toEqual(["copy-1", "copy-2"]);
    expect(deletePage(withoutFirst, "page-2")).toBe(withoutFirst);
  });

  test("rejects layers assigned to another page than their parent", () => {
    const document = blankDesignDocument();
    document.pages.push({ id: "page-2", name: "Page 2" });
    document.nodes = [
      buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 200, height: 200 }),
      {
        ...buildDrawnNode("text", "text", "frame", { x: 10, y: 10, width: 80, height: 20 }),
        pageId: "page-2",
      },
    ];
    expect(() => parseDesignDocument(document)).toThrow("share its parent's page");
  });

  test("grouping and layer order stay within the current page", () => {
    const document = blankDesignDocument();
    document.pages.push({ id: "page-2", name: "Page 2" });
    const box = { x: 10, y: 10, width: 80, height: 20 };
    document.nodes = [
      buildDrawnNode("first-page", "container", null, box),
      { ...buildDrawnNode("a", "container", null, box), pageId: "page-2" },
      { ...buildDrawnNode("b", "container", null, { ...box, x: 100 }), pageId: "page-2" },
    ];
    expect(moveLayer(document, "a", -1).nodes.map((node) => node.id)).toEqual([
      "first-page",
      "a",
      "b",
    ]);
    const grouped = groupLayers(document, ["a", "b"], "group");
    expect(pageNodes(grouped, "page-2").map((node) => node.id)).toEqual(["group", "a", "b"]);
    expect(pageNodes(grouped, "page-1").map((node) => node.id)).toEqual(["first-page"]);
  });
});
