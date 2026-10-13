import { readFile } from "node:fs/promises";
import { zipSync, deflateSync } from "fflate";
import { assembleCanvasFig, encodeFigParts, type FigNode } from "openfig-core";
import { decodeFigma } from "@bella/design/figma";

/** Synthetic source references: no private design-system content. */
export async function fidelityFixture(image: Uint8Array) {
  const document = decodeFigma(
    new Uint8Array(
      await readFile(new URL("../../apps/web/scripts/fixtures/figma/circle.fig", import.meta.url)),
    ),
  );
  const page = document.nodes.find((n) => n.type === "CANVAS" && !n.internalOnly)!;
  const hash = "0123456789abcdef0123456789abcdef01234567";
  const layer = (
    id: number,
    parent: number,
    name: string,
    x: number,
    y: number,
    width: number,
    height: number,
    rgb = [1, 0, 0],
  ): FigNode => ({
    guid: { sessionID: 9, localID: id },
    parentIndex: {
      guid: parent ? { sessionID: 9, localID: parent } : page.guid,
      position: String(id).padStart(3, "0"),
    },
    type: "RECTANGLE",
    name,
    size: { x: width, y: height },
    transform: { m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y },
    fillPaints: [
      {
        type: "SOLID",
        visible: true,
        opacity: 1,
        color: { r: rgb[0], g: rgb[1], b: rgb[2], a: 1 },
      },
    ],
  });
  const frame = { ...layer(1, 0, "Fidelity reference", 0, 0, 400, 320, [1, 1, 1]), type: "FRAME" };
  const before = layer(2, 1, "Outside mask", 240, 20, 40, 40, [0, 0, 1]);
  const mask = {
    ...layer(3, 1, "Alpha source", 20, 20, 200, 100),
    type: "FRAME",
    mask: true,
    fillPaints: [
      {
        type: "IMAGE",
        visible: true,
        opacity: 1,
        image: { hash: new Uint8Array(hash.match(/../g)!.map((n) => parseInt(n, 16))) },
      },
    ],
  };
  const content = layer(4, 1, "Masked red", 20, 20, 200, 100);
  // A new parent ends the mask scope. Two 40px children in 320px leave
  // three equal 80px spaces, independent of their initially measured boxes.
  const stack = {
    ...layer(5, 0, "Even spacing", 420, 0, 320, 60, [1, 1, 1]),
    type: "FRAME",
    stackMode: "HORIZONTAL",
    stackPrimaryAlignItems: "SPACE_EVENLY",
  } as FigNode;
  const first = layer(6, 5, "First", 80, 0, 40, 40, [0, 1, 0]),
    second = layer(7, 5, "Second", 200, 0, 40, 40, [0, 0, 1]);
  const characters = "Normal bold under";
  const text = {
    ...layer(8, 0, "Formatted label", 20, 340, 300, 40, [0, 0, 0]),
    type: "TEXT",
    fontSize: 20,
    fontName: { family: "Arial", style: "Regular", postscript: "" },
    textData: {
      characters,
      characterStyleIDs: [...characters].map((_, i) => (i >= 12 ? 3 : i >= 7 ? 2 : 0)),
      styleOverrideTable: [
        { styleID: 2, fontName: { family: "Arial", style: "Bold", postscript: "" } },
        { styleID: 3, textDecoration: "UNDERLINE" },
      ],
    },
  } as FigNode;
  document.message = {
    ...(document.message as object),
    nodeChanges: [page, frame, before, mask, content, stack, first, second, text],
  };
  const parts = encodeFigParts(document);
  const canvas = assembleCanvasFig({
    prelude: "fig-kiwi",
    version: parts.version,
    schemaCompressed: parts.schemaCompressed,
    messageCompressed: deflateSync(parts.messageRaw),
  });
  return zipSync({ "canvas.fig": canvas, [`images/${hash}`]: image });
}
