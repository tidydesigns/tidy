import { test, expect } from "bun:test";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { resizeSelectedLayers, wrapLayers } from "./layout-operations";
import { nodeStyle } from "./node-style";
const node = (id, x = 0, y = 0, width = 100, height = 50, parentId = null) =>
  buildDrawnNode(id, "container", parentId, { x, y, width, height });
const doc = (nodes) => parseDesignDocument({ ...blankDesignDocument(), nodes });
test("wrapping a measured selection preserves positions, stacking, and nested responsive content", () => {
  const parent = node("parent", 10, 20, 500, 300);
  const a = { ...node("a", 0, 0, 100, 50, "parent"), widthMode: "fill" };
  const b = node("b", 200, 100, 100, 50, "parent");
  const nested = { ...node("nested", 20, 10, 20, 10, "a"), horizontalConstraint: "scale" };
  const before = doc([parent, a, nested, b]);
  const measured = new Map([
    ["a", { x: 30, y: 40, width: 300, height: 50 }],
    ["b", b.box],
  ]);
  const result = wrapLayers(before, ["a", "nested", "b"], "wrapper", "frame", measured);
  const wrapper = result.document.nodes.find((n) => n.id === "wrapper");
  expect(wrapper.box).toEqual({ x: 30, y: 40, width: 300, height: 110 });
  expect(wrapper.style.overflow).toBe("hidden");
  const copied = result.document.nodes.find((n) => n.id === "a");
  expect(copied.box).toEqual({ x: 0, y: 0, width: 300, height: 50 });
  expect(copied.widthMode).toBe("fixed");
  expect(result.document.nodes.find((n) => n.id === "nested").box.x).toBe(60);
  expect(result.document.nodes.filter((n) => n.parentId === "wrapper").map((n) => n.id)).toEqual([
    "a",
    "b",
  ]);
  expect(result.document.nodes.indexOf(wrapper)).toBeLessThan(
    result.document.nodes.indexOf(copied),
  );
});
test("frame wrapping includes rotated visual bounds without changing child rotation", () => {
  const a = { ...node("a", 10, 20, 100, 50), style: { rotation: 90 } };
  const result = wrapLayers(doc([a]), ["a"], "wrapper", "frame");
  const wrapper = result.document.nodes.find((n) => n.id === "wrapper"),
    child = result.document.nodes.find((n) => n.id === "a");
  expect(wrapper.box.width).toBeCloseTo(50, 8);
  expect(wrapper.box.height).toBeCloseTo(100, 8);
  expect(wrapper.box.x + child.box.x).toBeCloseTo(a.box.x, 8);
  expect(wrapper.box.y + child.box.y).toBeCloseTo(a.box.y, 8);
  expect(child.style.rotation).toBe(90);
});
test("auto layout infers axis, order, spacing, cross alignment and hug sizing", () => {
  const a = node("a", 10, 50, 100, 40),
    b = node("b", 140, 45, 80, 50);
  const result = wrapLayers(doc([b, a]), ["a", "b"], "wrapper", "auto");
  const wrapper = result.document.nodes.find((n) => n.id === "wrapper");
  expect(wrapper.layout).toBe("flex-row");
  expect(wrapper.gap).toBe(30);
  expect(wrapper.align).toBe("center");
  expect(wrapper.widthMode).toBe("hug");
  expect(result.document.nodes.filter((n) => n.parentId === "wrapper").map((n) => n.id)).toEqual([
    "a",
    "b",
  ]);
});
test("auto layout retains uneven gaps and cross-axis positions as editable child offsets", () => {
  const a = node("a", 10, 20, 30, 20),
    b = node("b", 55, 30, 20, 20),
    c = node("c", 105, 10, 30, 25);
  const result = wrapLayers(doc([c, a, b]), ["a", "b", "c"], "wrapper", "auto");
  const wrapper = result.document.nodes.find((n) => n.id === "wrapper");
  const children = result.document.nodes.filter((n) => n.parentId === "wrapper");
  expect(wrapper.layout).toBe("flex-row");
  expect(wrapper.gap).toBe(22.5);
  expect(wrapper.minWidth).toBe(125);
  expect(wrapper.minHeight).toBe(40);
  expect(children.map((n) => n.id)).toEqual(["a", "b", "c"]);
  expect(children.map((n) => n.flowGapBefore)).toEqual([undefined, -7.5, 7.5]);
  expect(children.map((n) => n.flowCrossOffset)).toEqual([10, 20, undefined]);
  const styles = children.map((child, index) => nodeStyle(child, "flex-row", {}, wrapper, index));
  expect(styles.map((style) => style.marginLeft)).toEqual([undefined, -7.5, 7.5]);
  expect(styles.map((style) => style.top)).toEqual([10, 20, undefined]);
  expect(styles[0].width).toBe(30);
});
test("a selected container gains auto layout in place with inferred independent padding", () => {
  const parent = node("parent", 0, 0, 300, 200),
    a = node("a", 20, 30, 100, 40, "parent"),
    b = node("b", 20, 100, 100, 40, "parent");
  const result = wrapLayers(doc([parent, a, b]), ["parent"], "unused", "auto");
  const root = result.document.nodes[0];
  expect(result.id).toBe("parent");
  expect(result.document.nodes.length).toBe(3);
  expect(root.layout).toBe("flex-column");
  expect(root.gap).toBe(30);
  expect([root.paddingTop, root.paddingRight, root.paddingBottom, root.paddingLeft]).toEqual([
    30, 180, 60, 20,
  ]);
});
test("wrapping rejects locked ancestors and nonconsecutive flow siblings", () => {
  const parent = { ...node("parent"), locked: true },
    a = node("a", 0, 0, 20, 20, "parent");
  expect(() => wrapLayers(doc([parent, a]), ["a"], "wrapper", "frame")).toThrow("Unlock");
  const row = { ...node("row"), layout: "flex-row" },
    one = node("one", 0, 0, 20, 20, "row"),
    two = node("two", 30, 0, 20, 20, "row"),
    three = node("three", 60, 0, 20, 20, "row");
  expect(() =>
    wrapLayers(doc([row, one, two, three]), ["one", "three"], "wrapper", "frame"),
  ).toThrow("consecutive");
});
test("negative gap overlaps later flow children and baseline alignment renders directly", () => {
  const row = { ...node("row"), layout: "flex-row", gap: -10, align: "baseline" };
  const child = node("child", 0, 0, 20, 20, "row");
  expect(nodeStyle(child, "flex-row", {}, row, 0).marginLeft).toBeUndefined();
  expect(nodeStyle(child, "flex-row", {}, row, 1).marginLeft).toBe(-10);
  expect(nodeStyle(row, "absolute", {}).alignItems).toBe("baseline");
  expect(
    nodeStyle({ ...child, positionMode: "absolute" }, "flex-row", {}, row, 1).marginLeft,
  ).toBeUndefined();
});
test("fit-to-content preserves world geometry with asymmetric padding and a rotated frame", async () => {
  const { fitContents } = await import("./layout-operations");
  const { rotatePoint } = await import("./resize-box");
  const root = {
    ...node("root", 20, 30, 300, 200),
    paddingLeft: 10,
    paddingRight: 20,
    paddingTop: 5,
    paddingBottom: 15,
    style: { rotation: 35, borderWidth: 2 },
  };
  const child = node("child", 40, 50, 100, 60, "root");
  const before = doc([root, child]);
  const after = fitContents(before, "root");
  const nextRoot = after.nodes[0],
    nextChild = after.nodes[1];
  expect(nextRoot.box.width).toBe(134);
  expect(nextRoot.box.height).toBe(84);
  const worldCenter = (p, c) => {
    const r = rotatePoint(
      {
        x: c.box.x + 2 + c.box.width / 2 - p.box.width / 2,
        y: c.box.y + 2 + c.box.height / 2 - p.box.height / 2,
      },
      p.style.rotation,
    );
    return { x: p.box.x + p.box.width / 2 + r.x, y: p.box.y + p.box.height / 2 + r.y };
  };
  const a = worldCenter(root, child),
    b = worldCenter(nextRoot, nextChild);
  expect(b.x).toBeCloseTo(a.x, 7);
  expect(b.y).toBeCloseTo(a.y, 7);
});
test("ungrouping uses measured flow offsets, preserves stacking and composes transforms", async () => {
  const { unwrapLayer } = await import("./layout-operations");
  const root = {
      ...node("root", 20, 30, 200, 100),
      layout: "flex-column",
      style: { rotation: 90, flipX: true },
    },
    a = { ...node("a", 0, 0, 20, 20, "root"), style: { rotation: 10 } },
    b = node("b", 0, 80, 20, 20, "root");
  const before = doc([node("under"), root, a, b, node("over")]);
  const after = unwrapLayer(
    before,
    "root",
    new Map([["b", { x: 0, y: 25, width: 20, height: 20 }]]),
  );
  expect(after.nodes.map((n) => n.id)).toEqual(["under", "a", "b", "over"]);
  expect(after.nodes.find((n) => n.id === "a").style.rotation).toBe(80);
  expect(after.nodes.find((n) => n.id === "a").style.flipX).toBe(true);
  expect(
    after.nodes.find((n) => n.id === "b").box.x - after.nodes.find((n) => n.id === "a").box.x,
  ).toBeCloseTo(-25, 7);
  expect(after.nodes.every((n) => n.parentId === null)).toBe(true);
});
test("proportional scaling updates descendants, typography, spacing and effects without moving external instances", async () => {
  const { scaleLayers } = await import("./layout-operations");
  const { makeComponent, createComponentInstance } = await import("./document-operations");
  const root = {
    ...node("root", 10, 20, 200, 100),
    gap: 10,
    paddingTop: 12,
    style: { radius: 8, borderWidth: 1, shadow: "0px 2px 6px #000000" },
  };
  const text = {
    ...buildDrawnNode("text", "text", "root", { x: 10, y: 20, width: 80, height: 25 }),
    flowGapBefore: 5,
    flowCrossOffset: -3,
    style: {
      fontSize: 20,
      letterSpacing: 1,
      shadows: [{ x: 1, y: 2, blur: 4, spread: 0, color: "#000000", visible: true, inset: false }],
    },
  };
  let before = makeComponent(doc([root, text]), "root");
  let index = 0;
  const instance = createComponentInstance(before, "root", () => `copy-${++index}`);
  before = instance.document;
  const after = scaleLayers(before, ["root"], 2);
  const scaledRoot = after.nodes.find((n) => n.id === "root"),
    scaledText = after.nodes.find((n) => n.id === "text");
  expect(scaledRoot.box).toEqual({ x: 10, y: 20, width: 400, height: 200 });
  expect(scaledRoot.gap).toBe(20);
  expect(scaledRoot.paddingTop).toBe(24);
  expect(scaledRoot.style.radius).toBe(16);
  expect(scaledRoot.style.shadow).toBe("0px 4px 12px #000000");
  expect(scaledText.box).toEqual({ x: 20, y: 40, width: 160, height: 50 });
  expect(scaledText.flowGapBefore).toBe(10);
  expect(scaledText.flowCrossOffset).toBe(-6);
  expect(scaledText.style.fontSize).toBe(40);
  expect(scaledText.style.shadows[0].blur).toBe(8);
  const clone = after.nodes.find((n) => n.id === instance.rootId);
  expect(clone.box.x).toBe(34);
  expect(clone.box.y).toBe(44);
  expect(clone.box.width).toBe(400);
  expect(() => scaleLayers(before, ["root"], 100)).toThrow("limits");
  expect(scaleLayers(before, ["root"], 1)).toBe(before);
});
test("scaling an instance leaves unrelated appearance and content linked to its master", async () => {
  const { scaleLayers } = await import("./layout-operations");
  const { makeComponent, createComponentInstance } = await import("./document-operations");
  const { syncComponentEdit } = await import("./component-sync");
  const root = { ...node("root"), style: { fill: "#ff0000", radius: 8 } };
  let before = makeComponent(doc([root]), "root");
  let count = 0;
  const copy = createComponentInstance(before, "root", () => `copy-${++count}`);
  before = copy.document;
  const scaled = scaleLayers(before, [copy.rootId], 2);
  const changed = syncComponentEdit(scaled.nodes, "root", { style: { fill: "#0000ff" } });
  const instance = changed.find((n) => n.id === copy.rootId);
  expect(instance.style.fill).toBe("#0000ff");
  expect(instance.style.radius).toBe(16);
  expect(instance.instanceOverrides).not.toContain("style.fill");
  expect(instance.instanceOverrides).not.toContain("style.shadows");
});
test("multi-selection resize changes geometry without scaling appearance and respects locked ancestry", () => {
  const parent = node("parent", 0, 0, 400, 300),
    a = { ...node("a", 10, 20, 50, 30, "parent"), style: { radius: 8 } },
    b = { ...node("b", 110, 80, 50, 30, "parent"), style: { fontSize: 20 } };
  const before = doc([parent, a, b]);
  const target = { x: 10, y: 20, width: 300, height: 180 };
  const after = resizeSelectedLayers(before, ["a", "b"], target);
  expect(after.nodes.find((n) => n.id === "a").box).toEqual({
    x: 10,
    y: 20,
    width: 100,
    height: 60,
  });
  expect(after.nodes.find((n) => n.id === "b").box).toEqual({
    x: 210,
    y: 140,
    width: 100,
    height: 60,
  });
  expect(after.nodes.find((n) => n.id === "a").style.radius).toBe(8);
  expect(after.nodes.find((n) => n.id === "b").style.fontSize).toBe(20);
  expect(resizeSelectedLayers(before, ["a", "b"], { x: 10, y: 20, width: 150, height: 90 })).toBe(
    before,
  );
  expect(() =>
    resizeSelectedLayers(
      { ...before, nodes: [{ ...parent, locked: true }, a, b] },
      ["a", "b"],
      target,
    ),
  ).toThrow("Unlock");
});
