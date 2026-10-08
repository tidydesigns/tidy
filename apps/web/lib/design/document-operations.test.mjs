import { test, expect } from "bun:test";
import { blankDesignDocument, buildDrawnNode } from "./document";
import {
  alignLayers,
  distributeLayers,
  groupLayers,
  makeComponent,
  moveLayer,
  relocateLayer,
  removeLayers,
  reparentLayer,
  ungroupLayer,
} from "./document-operations";
import { legacyToDocument } from "./legacy-to-document";

test("legacy shapes retain identity and geometry in the single document", () => {
  const document = legacyToDocument(
    [{ id: "frame", x: 40, y: 80, width: 400, height: 300 }],
    [{ id: "rectangle", x: 500, y: 90, width: 50, height: 70 }],
  );
  expect(document.nodes.map((node) => [node.id, node.type, node.box.x])).toEqual([
    ["frame", "artboard", 40],
    ["rectangle", "container", 500],
  ]);
});

test("group and ungroup preserve children world positions", () => {
  const parent = buildDrawnNode("frame", "artboard", null, {
    x: 100,
    y: 100,
    width: 400,
    height: 300,
  });
  const a = buildDrawnNode("a", "container", "frame", { x: 20, y: 30, width: 40, height: 40 });
  const b = buildDrawnNode("b", "container", "frame", { x: 100, y: 80, width: 30, height: 30 });
  const document = { ...blankDesignDocument(), nodes: [parent, a, b] };
  const grouped = groupLayers(document, ["a", "b"], "group");
  expect(grouped.nodes.find((node) => node.id === "group")?.box).toEqual({
    x: 20,
    y: 30,
    width: 110,
    height: 80,
  });
  const restored = ungroupLayer(grouped, "group");
  expect(restored.nodes.find((node) => node.id === "a")?.box).toEqual(a.box);
  expect(restored.nodes.find((node) => node.id === "b")?.box).toEqual(b.box);
});

test("alignment and layer order operate on sibling nodes", () => {
  const a = buildDrawnNode("a", "container", null, { x: 10, y: 5, width: 20, height: 20 });
  const b = buildDrawnNode("b", "container", null, { x: 50, y: 20, width: 30, height: 20 });
  const document = { ...blankDesignDocument(), nodes: [a, b] };
  expect(alignLayers(document, ["a", "b"], "right").nodes.map((node) => node.box.x)).toEqual([
    60, 50,
  ]);
  expect(alignLayers(document, ["a", "b"], "left", "b").nodes.map((node) => node.box.x)).toEqual([
    50, 50,
  ]);
  expect(
    alignLayers(document, ["a", "b"], "center-y", "a").nodes.map((node) => node.box.y),
  ).toEqual([5, 5]);
  expect(() => alignLayers(document, ["a", "b"], "left", "missing")).toThrow("selected layer");
  expect(moveLayer(document, "a", 1).nodes.map((node) => node.id)).toEqual(["b", "a"]);
});

test("reparenting retains position and rejects descendant targets", () => {
  const frame = buildDrawnNode("frame", "artboard", null, {
    x: 100,
    y: 100,
    width: 400,
    height: 300,
  });
  const group = buildDrawnNode("group", "container", "frame", {
    x: 20,
    y: 30,
    width: 100,
    height: 100,
  });
  const child = buildDrawnNode("child", "container", "group", {
    x: 10,
    y: 15,
    width: 20,
    height: 20,
  });
  const document = { ...blankDesignDocument(), nodes: [frame, group, child] };
  expect(
    reparentLayer(document, "child", "frame").nodes.find((node) => node.id === "child")?.box,
  ).toEqual({ x: 30, y: 45, width: 20, height: 20 });
  expect(() => reparentLayer(document, "group", "child")).toThrow();
});

test("locked ancestors protect descendants from cut, delete, and reparent", () => {
  const frame = {
    ...buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 200, height: 200 }),
    locked: true,
  };
  const child = buildDrawnNode("child", "container", "frame", {
    x: 10,
    y: 10,
    width: 20,
    height: 20,
  });
  const second = buildDrawnNode("second", "container", "frame", {
    x: 50,
    y: 10,
    width: 20,
    height: 20,
  });
  const third = buildDrawnNode("third", "container", "frame", {
    x: 90,
    y: 10,
    width: 20,
    height: 20,
  });
  const document = { ...blankDesignDocument(), nodes: [frame, child, second, third] };
  expect(() => removeLayers(document, ["child"])).toThrow("Unlock selected");
  expect(() => reparentLayer(document, "child", null)).toThrow("unlocked frame");
  expect(() => relocateLayer(document, "child", "frame", "after")).toThrow("unlocked layers");
  expect(() => moveLayer(document, "child", 1)).toThrow("Unlock this layer");
  expect(() => makeComponent(document, "child")).toThrow("unlocked layer");
  expect(() => groupLayers(document, ["child", "second"], "group")).toThrow("unlocked sibling");
  expect(() => alignLayers(document, ["child", "second"], "left")).toThrow("unlocked sibling");
  expect(() => distributeLayers(document, ["child", "second", "third"], "horizontal")).toThrow(
    "unlocked sibling",
  );
});

test("distribution spaces at least three sibling layers evenly", () => {
  const nodes = [0, 35, 100].map((x, index) =>
    buildDrawnNode(`layer-${index}`, "container", null, { x, y: 0, width: 10, height: 10 }),
  );
  const document = { ...blankDesignDocument(), nodes };
  expect(
    distributeLayers(
      document,
      nodes.map((node) => node.id),
      "horizontal",
    ).nodes.map((node) => node.box.x),
  ).toEqual([0, 50, 100]);
});
