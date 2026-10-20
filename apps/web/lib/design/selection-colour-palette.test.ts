import { expect, test } from "bun:test";
import { buildDrawnNode, type DesignNode } from "./document";
import {
  createColourPalette,
  reconcileColourPalette,
  recolourPalette,
  indexSelectionColours,
  type ColourPalette,
} from "../../../../packages/editor/src/editor/inspector/selection-colour-palette";

import { nodeChildrenIndex } from "../../../../packages/editor/src/design/node-index";

const colours = ["#1e1e1e", "#ff5d00", "#f2f2f0"];
function row(palette: ColourPalette, colour: string) {
  const found = palette.rows.find((entry) => entry.colour === colour);
  if (!found) throw new Error(`Missing colour ${colour}`);
  return found;
}

test("merging colours, undoing and redoing preserve the edited row without duplicate or recycled keys", () => {
  const initial = createColourPalette(colours);
  const black = row(initial, "#1e1e1e"),
    orange = row(initial, "#ff5d00");
  const merged = recolourPalette(initial, black.id, "#f2f2f0");
  expect(merged.rows.map((entry) => entry.colour)).toEqual(["#f2f2f0", "#ff5d00"]);
  expect(row(merged, "#f2f2f0").id).toBe(black.id);
  expect(row(merged, "#ff5d00")).toBe(orange);
  const undone = reconcileColourPalette(merged, colours);
  expect(new Set(undone.rows.map((entry) => entry.id)).size).toBe(colours.length);
  expect(row(undone, "#1e1e1e").id).not.toBe(black.id);
  const redone = reconcileColourPalette(
    undone,
    merged.rows.map((entry) => entry.colour),
  );
  const undoneAgain = reconcileColourPalette(redone, colours);
  expect(new Set(undoneAgain.rows.map((entry) => entry.id)).size).toBe(colours.length);
  expect(row(undoneAgain, "#1e1e1e").id).toBeGreaterThan(row(undone, "#1e1e1e").id);
  expect(initial.rows.map((entry) => entry.colour)).toEqual(colours);
});

test("unrelated document updates and unchanged colour edits preserve palette identity", () => {
  const palette = createColourPalette(colours);
  expect(reconcileColourPalette(palette, [...colours])).toBe(palette);
  expect(recolourPalette(palette, row(palette, "#1e1e1e").id, "#1e1e1e")).toBe(palette);
});

test("the colour index deduplicates matching nodes while preserving token alpha, visibility and order", () => {
  const node = (id: string, style: DesignNode["style"]): DesignNode => ({
    ...buildDrawnNode(id, "container", null, { x: 0, y: 0, width: 100, height: 100 }),
    style,
  });
  const first = node("first", {
    fill: "#000000",
    fillToken: "brand",
    color: "#22735980",
    outlineColor: "#FF5D00",
  });
  const second = node("second", {
    paints: [
      { id: "hidden", type: "solid", color: "#112233", visible: false, opacity: 1 },
      { id: "shown", type: "solid", color: "#ff5d00", visible: true, opacity: 1 },
    ],
  });
  const groups = indexSelectionColours([first, second], { brand: "#22735980" });
  expect([...groups.keys()]).toEqual(["#22735980", "#ff5d00"]);
  expect(groups.get("#22735980")).toEqual([first]);
  expect(groups.get("#ff5d00")).toEqual([first, second]);
});

test("selection hierarchy is reused across selections and refreshed for immutable document edits", () => {
  const parent = buildDrawnNode("parent", "container", null, {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  const child = { ...parent, id: "child", parentId: parent.id };
  const nodes = [parent, child];
  const index = nodeChildrenIndex(nodes);
  expect(nodeChildrenIndex(nodes)).toBe(index);
  expect(index.get(parent.id)).toEqual([child]);
  const moved = { ...child, parentId: null };
  expect(nodeChildrenIndex([parent, moved]).get(parent.id)).toBeUndefined();
  expect(index.get(parent.id)).toEqual([child]);
});
