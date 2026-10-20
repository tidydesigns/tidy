import { expect, test } from "bun:test";
import { buildDrawnNode, type DesignNode } from "./document";
import { selectionColors } from "./selection-colors";
import {
  createColourPalette,
  reconcileColourPalette,
  recolourPalette,
  indexSelectionColours,
  type ColourPalette,
} from "../../../../packages/editor/src/editor/selection-colour-palette";

const colours = ["#1e1e1e", "#777777", "#ff5d00", "#f2f2f0"];
function row(palette: ColourPalette, colour: string) {
  const found = palette.rows.find((entry) => entry.colour === colour);
  if (!found) throw new Error(`Missing colour ${colour}`);
  return found;
}
const node = (id: string, style: DesignNode["style"]): DesignNode => ({
  ...buildDrawnNode(id, "container", null, { x: 0, y: 0, width: 100, height: 100 }),
  style,
});

test("merging black into an existing background keeps the edited row identity and removes the duplicate", () => {
  const palette = createColourPalette(colours);
  const black = row(palette, "#1e1e1e");
  const orange = row(palette, "#ff5d00");
  const merged = recolourPalette(palette, black.id, "#f2f2f0");
  expect(merged.rows.map((entry) => entry.colour)).toEqual(["#f2f2f0", "#777777", "#ff5d00"]);
  expect(row(merged, "#f2f2f0").id).toBe(black.id);
  expect(row(merged, "#ff5d00")).toBe(orange);
  expect(palette.rows.map((entry) => entry.colour)).toEqual(colours);
});

test("undo after a merge restores two distinct React row keys instead of reusing the merged key", () => {
  const palette = createColourPalette(colours);
  const black = row(palette, "#1e1e1e");
  const merged = recolourPalette(palette, black.id, "#f2f2f0");
  const undone = reconcileColourPalette(merged, colours);
  expect(new Set(undone.rows.map((entry) => entry.id)).size).toBe(colours.length);
  expect(row(undone, "#f2f2f0").id).toBe(black.id);
  expect(row(undone, "#1e1e1e").id).toBe(palette.nextId);
  expect(undone.nextId).toBe(palette.nextId + 1);
});

test("repeated merge, undo and redo never duplicate or recycle a discarded row key", () => {
  let palette = createColourPalette(colours);
  const allocated = new Set(palette.rows.map((entry) => entry.id));
  for (let iteration = 0; iteration < 100; iteration++) {
    const source = row(palette, "#1e1e1e");
    palette = recolourPalette(palette, source.id, "#f2f2f0");
    palette = reconcileColourPalette(palette, colours);
    const restored = row(palette, "#1e1e1e");
    expect(allocated.has(restored.id)).toBe(false);
    allocated.add(restored.id);
    expect(new Set(palette.rows.map((entry) => entry.id)).size).toBe(colours.length);
    palette = reconcileColourPalette(
      palette,
      colours.filter((colour) => colour !== "#1e1e1e"),
    );
    expect(new Set(palette.rows.map((entry) => entry.id)).size).toBe(colours.length - 1);
    palette = reconcileColourPalette(palette, colours);
    const undoneAgain = row(palette, "#1e1e1e");
    expect(allocated.has(undoneAgain.id)).toBe(false);
    allocated.add(undoneAgain.id);
  }
});

test("unrelated document updates preserve the palette and all row objects", () => {
  const palette = createColourPalette(colours);
  expect(reconcileColourPalette(palette, [...colours])).toBe(palette);
  expect(recolourPalette(palette, 0, "#1e1e1e")).toBe(palette);
  expect(recolourPalette(palette, 9999, "#f2f2f0")).toBe(palette);
});

test("reordering keeps existing keys and allocates keys only for newly introduced colours", () => {
  const palette = createColourPalette(colours);
  const next = reconcileColourPalette(palette, ["#ff5d00", "#224466", "#1e1e1e"]);
  expect(next.rows[0]).toBe(row(palette, "#ff5d00"));
  expect(next.rows[2]).toBe(row(palette, "#1e1e1e"));
  expect(row(next, "#224466").id).toBe(palette.nextId);
  expect(next.nextId).toBe(palette.nextId + 1);
});

test("empty selections can be repopulated without reusing previous keys", () => {
  const initial = createColourPalette([]);
  const populated = reconcileColourPalette(initial, colours);
  const empty = reconcileColourPalette(populated, []);
  expect(empty.rows).toEqual([]);
  expect(reconcileColourPalette(empty, colours).rows.map((entry) => entry.id)).toEqual([
    4, 5, 6, 7,
  ]);
});

test("palette operations do not mutate frozen caller state", () => {
  const palette = createColourPalette(colours);
  palette.rows.forEach(Object.freeze);
  Object.freeze(palette.rows);
  Object.freeze(palette);
  expect(recolourPalette(palette, 0, "#224466").rows[0]).toEqual({ id: 0, colour: "#224466" });
  expect(reconcileColourPalette(palette, ["#224466"]).rows[0]).toEqual({
    id: 4,
    colour: "#224466",
  });
});

test("the colour index contains each matching node once even when several paints use the same colour", () => {
  const first = node("first", { fill: "#1E1E1E", color: "#1e1e1e", outlineColor: "#ff5d00" });
  const second = node("second", { fill: "#ff5d00", color: "#777777" });
  const groups = indexSelectionColours([first, second], {});
  expect(groups.get("#1e1e1e")).toEqual([first]);
  expect(groups.get("#ff5d00")).toEqual([first, second]);
  expect(groups.get("#777777")).toEqual([second]);
  expect([...groups.keys()]).toEqual(selectionColors([first, second], {}));
});

test("indexing preserves resolved token colours, alpha, paint visibility and source order", () => {
  const first = node("token", { fill: "#000000", fillToken: "brand" });
  const second = node("stack", {
    paints: [
      { id: "hidden", type: "solid", color: "#112233", visible: false, opacity: 1 },
      { id: "shown", type: "solid", color: "#22735980", visible: true, opacity: 1 },
    ],
  });
  const groups = indexSelectionColours([first, second], { brand: "#22735980" });
  expect([...groups.keys()]).toEqual(["#22735980"]);
  expect(groups.get("#22735980")).toEqual([first, second]);
  expect(indexSelectionColours([], {}).size).toBe(0);
});
