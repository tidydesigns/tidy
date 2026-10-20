import type { DesignNode } from "../design/document";
import { selectionColors } from "../design/selection-colors";

type ColourRow = { readonly id: number; readonly colour: string };
export type ColourPalette = { readonly rows: readonly ColourRow[]; readonly nextId: number };

export function createColourPalette(colours: readonly string[]): ColourPalette {
  return { rows: colours.map((colour, id) => ({ colour, id })), nextId: colours.length };
}

export function reconcileColourPalette(
  palette: ColourPalette,
  colours: readonly string[],
): ColourPalette {
  if (
    palette.rows.length === colours.length &&
    palette.rows.every((row, index) => row.colour === colours[index])
  )
    return palette;
  const previous = new Map(palette.rows.map((row) => [row.colour, row]));
  let nextId = palette.nextId;
  return {
    rows: colours.map((colour) => previous.get(colour) ?? { colour, id: nextId++ }),
    nextId,
  };
}

export function recolourPalette(palette: ColourPalette, id: number, colour: string): ColourPalette {
  const edited = palette.rows.find((row) => row.id === id);
  if (!edited || edited.colour === colour) return palette;
  const rows: ColourRow[] = [];
  for (const row of palette.rows) {
    if (row.id === id) rows.push({ id, colour });
    else if (row.colour !== colour) rows.push(row);
  }
  return { ...palette, rows };
}

export function indexSelectionColours(
  nodes: readonly DesignNode[],
  tokens: Record<string, string>,
) {
  const groups = new Map<string, DesignNode[]>();
  for (const node of nodes) {
    for (const colour of selectionColors([node], tokens)) {
      const group = groups.get(colour);
      if (group) group.push(node);
      else groups.set(colour, [node]);
    }
  }
  return groups;
}
