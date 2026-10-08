import { test, expect } from "bun:test";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { editLayers } from "./edit-document";
import { nodeStyle } from "./node-style";
import { makeComponent, createComponentInstance } from "./document-operations";
const frame = buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 400, height: 300 });
const child = (id, horizontalConstraint, verticalConstraint = "start", parentId = "frame") => ({
  ...buildDrawnNode(id, "container", parentId, { x: 20, y: 30, width: 100, height: 50 }),
  horizontalConstraint,
  verticalConstraint,
});
const fixture = (nodes) =>
  parseDesignDocument({ ...blankDesignDocument(), nodes: [frame, ...nodes] });
test("parent resizing preserves left, right, center, stretch and proportional constraints", () => {
  const doc = fixture([
    child("left", "start"),
    child("right", "end", "end"),
    child("center", "center", "center"),
    child("stretch", "stretch", "stretch"),
    child("scale", "scale", "scale"),
  ]);
  const next = editLayers(doc, ["frame"], { box: { width: 600, height: 600 } });
  const boxes = Object.fromEntries(next.nodes.map((n) => [n.id, n.box]));
  expect(boxes.left).toEqual({ x: 20, y: 30, width: 100, height: 50 });
  expect(boxes.right).toEqual({ x: 220, y: 330, width: 100, height: 50 });
  expect(boxes.center).toEqual({ x: 120, y: 180, width: 100, height: 50 });
  expect(boxes.stretch).toEqual({ x: 20, y: 30, width: 300, height: 350 });
  expect(boxes.scale).toEqual({ x: 30, y: 60, width: 150, height: 100 });
  expect(editLayers(next, ["frame"], { box: frame.box }).nodes.map((n) => n.box)).toEqual(
    doc.nodes.map((n) => n.box),
  );
});
test("nested constraints cascade, including locked children, without changing flow children", () => {
  const parent = {
    ...child("panel", "stretch", "stretch"),
    box: { x: 10, y: 10, width: 300, height: 200 },
  };
  const badge = { ...child("badge", "end", "end", "panel"), locked: true };
  const flowParent = { ...child("row", "start"), layout: "flex-row" };
  const flowChild = child("flow-child", "end", "end", "row");
  const doc = fixture([badge, flowChild, parent, flowParent]); // Deliberately not in parent order.
  const next = editLayers(doc, ["frame"], { box: { width: 500, height: 400 } });
  expect(next.nodes.find((n) => n.id === "badge").box).toEqual({
    x: 120,
    y: 130,
    width: 100,
    height: 50,
  });
  const row = editLayers(next, ["row"], { box: { width: 200, height: 100 } });
  expect(row.nodes.find((n) => n.id === "flow-child").box).toEqual(flowChild.box);
});
test("constraints use the interior between independent borders and support absolute children in flow", () => {
  const doc = fixture([{ ...child("right", "end"), positionMode: "absolute" }]);
  const next = editLayers(doc, ["frame"], {
    layout: "flex-row",
    style: { borderLeftWidth: 10, borderRightWidth: 20 },
  });
  expect(next.nodes.find((n) => n.id === "right").box.x).toBe(-10);
  expect(nodeStyle(next.nodes[1], "flex-row", {}, next.nodes[0]).left).toBe("calc(100% - 380px)");
});
test("instance child constraints follow their own parent size without creating overrides", () => {
  let doc = fixture([
    { ...child("master", "start"), box: { x: 20, y: 30, width: 200, height: 100 } },
    child("content", "end", "end", "master"),
  ]);
  doc = makeComponent(doc, "master");
  let count = 0;
  const instance = createComponentInstance(doc, "master", () => `instance-${++count}`);
  doc = instance.document;
  const next = editLayers(doc, [instance.rootId], { box: { width: 300, height: 200 } });
  const copiedChild = next.nodes.find((n) => n.componentSourceId === "content");
  expect(copiedChild.box).toEqual({ x: 120, y: 130, width: 100, height: 50 });
  expect(copiedChild.instanceOverrides ?? []).toEqual([]);
  expect(next.nodes.find((n) => n.id === "content").box).toEqual({
    x: 20,
    y: 30,
    width: 100,
    height: 50,
  });
});
test("renderer constraints follow runtime parent size, while older documents retain their style", () => {
  const n = child("n", "scale", "center");
  expect(nodeStyle(n, "absolute", {}, frame)).toMatchObject({
    left: "5%",
    width: "25%",
    top: "calc(50% + -120px)",
  });
  const stretch = child("s", "stretch");
  expect(nodeStyle(stretch, "absolute", {}, frame).width).toBe("max(1px, calc(100% - 300px))");
  const legacy = {
    ...child("l", "start"),
    horizontalConstraint: undefined,
    verticalConstraint: undefined,
  };
  expect(nodeStyle(legacy, "absolute", {}, frame)).toMatchObject({
    left: 20,
    top: 30,
    width: 100,
    height: 50,
  });
});
test("canvas geometry converts back through runtime scaling and anchored fill parents", async () => {
  const { storedConstraintBox } = await import("./constraints");
  const n = child("n", "scale", "end");
  expect(
    storedConstraintBox({ x: 60, y: 330, width: 300, height: 50 }, n, frame, {
      width: 1200,
      height: 600,
    }),
  ).toEqual({ x: 20, y: 30, width: 100, height: 50 });
  const stretched = child("s", "stretch", "center");
  expect(
    storedConstraintBox({ x: 20, y: 180, width: 900, height: 50 }, stretched, frame, {
      width: 1200,
      height: 600,
    }),
  ).toEqual({ x: 20, y: 30, width: 100, height: 50 });
  const doc = fixture([n]);
  const moved = (await import("./edit-document")).moveLayers(
    doc,
    ["n"],
    30,
    10,
    new Map([["n", { width: 1200, height: 600 }]]),
  );
  expect(moved.nodes[1].box.x).toBe(30);
  expect(moved.nodes[1].box.y).toBe(40);
});
