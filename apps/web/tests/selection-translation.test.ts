import { expect, test } from "bun:test";
import { buildDrawnNode, type DesignNode } from "@tidy/design/document";
import { selectionTranslationDelta } from "../../../packages/editor/src/editor/selection-translation";

const node = buildDrawnNode("layer", "container", "parent", {
  x: 12,
  y: 20,
  width: 100,
  height: 60,
});
const moved = (source: DesignNode): DesignNode => ({
  ...source,
  box: { ...source.box, x: source.box.x + 10, y: source.box.y - 5 },
});

test("fixed layers can reuse measured geometry for translations in either direction", () => {
  expect(selectionTranslationDelta(node, moved(node))).toEqual({ x: 10, y: -5 });
  expect(selectionTranslationDelta(moved(node), node)).toEqual({ x: -10, y: 5 });
  const rotated = { ...node, style: { rotation: 37, flipX: true } };
  expect(selectionTranslationDelta(rotated, moved(rotated))).toEqual({ x: 10, y: -5 });
});

test("geometry and content changes require a new measurement", () => {
  const changes: Partial<DesignNode>[] = [
    { id: "other" },
    { parentId: "different-parent" },
    { box: { ...node.box, width: 120 } },
    { style: { rotation: 45 } },
    { layout: "flex-row" },
    { text: "Changed" },
    { tokenBindings: { width: "space.large" } },
  ];
  for (const change of changes)
    expect(selectionTranslationDelta(node, { ...moved(node), ...change })).toBeNull();
});

test("layout-dependent and composite layers retain live measurements", () => {
  const changes: Partial<DesignNode>[] = [
    { widthMode: "fill" },
    { widthMode: "hug" },
    { heightMode: "fill" },
    { heightMode: "hug" },
    ...(["center", "end", "stretch", "scale"] as const).flatMap((constraint) => [
      { horizontalConstraint: constraint },
      { verticalConstraint: constraint },
    ]),
    { responsiveBreakpoints: [{ id: "narrow", frameMaxWidth: 500, widthMode: "fill" }] },
    { instanceOf: "master" },
    { vectorBoolean: "union" },
    { mask: { enabled: true, sourceId: "mask", mode: "alpha" } },
  ];
  for (const change of changes) {
    const source = { ...node, ...change };
    expect(selectionTranslationDelta(source, moved(source))).toBeNull();
  }
});

test("flow, responsive, and hug ancestors require live geometry", async () => {
  const { canReuseSelectionAncestors } =
    await import("../../../packages/editor/src/editor/selection-translation");
  expect(canReuseSelectionAncestors([node])).toBe(true);
  expect(canReuseSelectionAncestors([{ ...node, style: { overflow: "auto" } }])).toBe(false);
  expect(canReuseSelectionAncestors([{ ...node, layout: "grid" }])).toBe(false);
  expect(canReuseSelectionAncestors([{ ...node, heightMode: "hug" }])).toBe(false);
  expect(
    canReuseSelectionAncestors([
      {
        ...node,
        responsiveBreakpoints: [{ id: "narrow", frameMaxWidth: 500, layout: "flex-row" }],
      },
    ]),
  ).toBe(false);
});
