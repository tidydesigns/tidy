import { expect, test } from "bun:test";
import { buildLoginDocument } from "@/lib/design/examples/login";
import { duplicateNodeTree } from "@/lib/design/duplicate-node";

test("duplicating an imported UI group copies its children as editable independent layers", () => {
  const document = buildLoginDocument();
  const source = {
    ...document,
    nodes: document.nodes.map((node) => ({ ...node, importKey: "bellarun:/login" })).reverse(),
  };
  let serial = 0;
  const copy = duplicateNodeTree(source, "desktop-panel", () => `copy-${++serial}`);
  expect(copy.nodes.length).toBe(14);
  expect(copy.nodes.find((node) => node.id === copy.rootId)?.parentId).toBe("desktop-screen");
  expect(copy.nodes.find((node) => node.name === "Welcome heading")?.parentId).toBe(copy.rootId);
  expect(copy.nodes.every((node) => !node.sourceKey && !node.importKey)).toBe(true);
  expect(copy.nodes.find((node) => node.id === copy.rootId)?.box.x).toBe(552);
});
