import { expect, test } from "bun:test";
import { buildDrawnNode, type DesignNode } from "./document";
import { selectionDragTarget } from "./selection-drag-target";
import { movableSelectionRoots } from "./edit-document";

const node = (id: string, parent: string | null = null): DesignNode =>
  buildDrawnNode(id, "container", parent, { x: 0, y: 0, width: 100, height: 80 });
const nodes = [node("frame"), node("group", "frame"), node("child", "group"), node("other")];
const index = new Map(nodes.map((node) => [node.id, node]));

test("dragging a selected group's child resolves to its selected ancestor", () => {
  expect(selectionDragTarget(index, ["group", "other"], "child")).toEqual({
    kind: "layer",
    id: "group",
  });
  expect(selectionDragTarget(index, ["child", "other"], "child")).toEqual({
    kind: "layer",
    id: "child",
  });
});

test("selection gaps allow ancestor backgrounds and canvas but preserve unrelated targets", () => {
  expect(selectionDragTarget(index, ["child", "group"], "frame")).toEqual({ kind: "gap" });
  expect(selectionDragTarget(index, ["child", "group"], null)).toEqual({ kind: "gap" });
  expect(selectionDragTarget(index, ["child", "group"], "other")).toBeNull();
  expect(selectionDragTarget(index, [], null)).toBeNull();
});

test("movement eligibility applies to roots instead of the child that receives the pointer", () => {
  const flowGroup = { ...node("group"), layout: "flex-row" as const };
  const child = node("child", "group");
  const absolute = { ...node("absolute", "group"), positionMode: "absolute" as const };
  const roots = movableSelectionRoots([flowGroup, child, absolute], ["group", "child", "absolute"]);
  expect(roots.map((node) => node.id)).toEqual(["group"]);
  expect(
    movableSelectionRoots([flowGroup, child, absolute], ["child", "absolute"]).map(
      (node) => node.id,
    ),
  ).toEqual(["absolute"]);
});

test("locked ancestors prevent dragging their descendants without blocking other movable roots", () => {
  const locked = { ...node("group"), locked: true };
  const child = node("child", "group");
  const other = node("other");
  expect(
    movableSelectionRoots([locked, child, other], ["child", "other"]).map((node) => node.id),
  ).toEqual(["other"]);
});
