import { describe, expect, test } from "bun:test";
import { buildDrawnNode } from "./document";
import {
  canvasSelectionTarget,
  hoverChildren,
  HOVER_CHILD_LIMIT,
  selectionScope,
  type SelectionScope,
} from "./selection-target";

const frame = buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 500, height: 500 });
const group = buildDrawnNode("group", "container", frame.id, frame.box);
const nested = buildDrawnNode("nested", "container", group.id, frame.box);
const leaf = buildDrawnNode("leaf", "text", nested.id, frame.box);
const nodes = new Map([frame, group, nested, leaf].map((node) => [node.id, node]));
const children = new Map([
  [frame.id, [group]],
  [group.id, [nested]],
  [nested.id, [leaf]],
]);
const scopeFor = (selectedIds: readonly string[]) =>
  selectionScope({ nodes, selectedIds, children });
const input = {
  hitId: leaf.id,
  nodes,
  scope: { kind: "canvas" } satisfies SelectionScope,
  deep: false,
  readOnly: false,
};

describe("canvas selection and hover use the same hierarchy", () => {
  test("starts at the artboard and preserves the same target across descendants", () => {
    expect(canvasSelectionTarget(input)?.id).toBe(frame.id);
    expect(canvasSelectionTarget({ ...input, deep: true })?.id).toBe(leaf.id);
  });
  test("selected parents expose their immediate children", () => {
    expect(canvasSelectionTarget({ ...input, scope: scopeFor([group.id]) })?.id).toBe(nested.id);
    expect(canvasSelectionTarget({ ...input, scope: scopeFor([nested.id]) })?.id).toBe(leaf.id);
    expect(canvasSelectionTarget({ ...input, scope: scopeFor([leaf.id]) })?.id).toBe(leaf.id);
  });
  test("artboards expose sections, leaves retain their parent scope, and outside hits return to the root", () => {
    expect(canvasSelectionTarget({ ...input, scope: scopeFor([frame.id]) })?.id).toBe(group.id);
    expect(scopeFor([leaf.id])).toEqual({ kind: "inside", id: nested.id });
    expect(
      canvasSelectionTarget({
        ...input,
        hitId: frame.id,
        scope: scopeFor([nested.id]),
      })?.id,
    ).toBe(frame.id);
    expect(scopeFor(["deleted"])).toEqual({ kind: "canvas" });
    expect(scopeFor([group.id, leaf.id])).toEqual({ kind: "canvas" });
  });
  test("empty containers are leaves and sibling multiselection retains its hierarchy", () => {
    const empty = { ...leaf, type: "container" as const };
    const updated = new Map(nodes).set(empty.id, empty);
    expect(selectionScope({ nodes: updated, children, selectedIds: [empty.id] })).toEqual({
      kind: "inside",
      id: nested.id,
    });
    const sibling = { ...leaf, id: "sibling" };
    updated.set(sibling.id, sibling);
    expect(
      selectionScope({ nodes: updated, children, selectedIds: [leaf.id, sibling.id] }),
    ).toEqual({ kind: "inside", id: nested.id });
  });
  test("hidden or locked ancestors prevent targeting, including in deep selection", () => {
    const locked = new Map(nodes).set(group.id, { ...group, locked: true });
    expect(canvasSelectionTarget({ ...input, nodes: locked, deep: true })).toBeNull();
    expect(canvasSelectionTarget({ ...input, nodes: locked })?.id).toBe(frame.id);
    expect(canvasSelectionTarget({ ...input, nodes: locked, deep: true, readOnly: true })?.id).toBe(
      leaf.id,
    );
    const hidden = new Map(nodes).set(group.id, { ...group, visible: false });
    expect(canvasSelectionTarget({ ...input, nodes: hidden, readOnly: true })).toBeNull();
  });
  test("missing and cyclic targets safely clear feedback", () => {
    expect(canvasSelectionTarget({ ...input, hitId: "missing" })).toBeNull();
    const cycle = new Map(nodes).set(group.id, { ...group, parentId: leaf.id });
    expect(canvasSelectionTarget({ ...input, nodes: cycle })).toBeNull();
  });
});

test("structural feedback stays bounded and excludes hidden or composite internals", () => {
  const children = new Map([[group.id, [leaf, { ...nested, visible: false }]]]);
  expect(hoverChildren(group, children)).toEqual([leaf]);
  expect(hoverChildren({ ...group, vectorBoolean: "union" }, children)).toEqual([]);
  expect(
    hoverChildren(
      { ...group, mask: { sourceId: nested.id, mode: "alpha", enabled: true } },
      children,
    ),
  ).toEqual([]);
  expect(
    hoverChildren(
      group,
      new Map([[group.id, Array.from({ length: HOVER_CHILD_LIMIT + 1 }, () => leaf)]]),
    ),
  ).toEqual([]);
});
