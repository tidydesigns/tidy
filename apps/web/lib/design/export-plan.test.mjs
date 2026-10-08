import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import {
  exportRoots,
  exportDimensions,
  exportNames,
  exportFilename,
  transformedExportBounds,
  unionExportBounds,
  matrixMultiply,
} from "./export-plan";
const nodes = [
  buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 200, height: 100 }),
  buildDrawnNode("child", "container", "frame", { x: 10, y: 20, width: 40, height: 30 }),
  buildDrawnNode("other", "container", null, { x: 250, y: 0, width: 60, height: 50 }),
];
const doc = () => parseDesignDocument({ ...blankDesignDocument(), nodes });
test("selection roots suppress selected descendants and preserve stacking order", () => {
  expect(exportRoots(doc(), ["other", "child", "frame"]).map((n) => n.id)).toEqual([
    "frame",
    "other",
  ]);
  expect(() => exportRoots(doc(), [])).toThrow("Select");
  const hidden = doc();
  hidden.nodes[0].visible = false;
  expect(() => exportRoots(hidden, ["frame"])).toThrow("Show");
});
test("scaled dimensions use rounded pixel bounds and reject unsupported allocations", () => {
  for (const scale of [0.25, 0.5, 1, 2, 3, 4])
    expect(exportDimensions({ x: 0, y: 0, width: 101, height: 51 }, scale)).toEqual({
      width: Math.ceil(101 * scale),
      height: Math.ceil(51 * scale),
    });
  expect(() => exportDimensions({ x: 0, y: 0, width: 10000, height: 10000 }, 1)).toThrow(
    "64 megapixels",
  );
  expect(() => exportDimensions({ x: 0, y: 0, width: 100, height: 100 }, 0)).toThrow("scale");
  expect(() => exportDimensions({ x: 0, y: 0, width: 100, height: 100 }, NaN)).toThrow("scale");
});
test("batch filenames are safe and unique even with case collisions and suffixed names", () => {
  const names = exportNames(
    [{ name: "../Button" }, { name: "button" }, { name: "button-2" }, { name: "??" }],
    2,
    "png",
  );
  expect(names).toEqual(["Button@2x.png", "button-2@2x.png", "button-2-2@2x.png", "layer@2x.png"]);
  expect(exportFilename("Native", 1, "svg")).toBe("Native.svg");
});
test("transformed selection bounds include rotations, negative coordinates and parent offsets", () => {
  const matrix = matrixMultiply([1, 0, 0, 1, 100, 50], [0, 1, -1, 0, 0, 0]);
  expect(transformedExportBounds({ x: 0, y: 0, width: 40, height: 20 }, matrix)).toEqual({
    x: 80,
    y: 50,
    width: 20,
    height: 40,
  });
  expect(
    unionExportBounds([
      { x: -10.2, y: -4.1, width: 40, height: 30 },
      { x: 20, y: 20, width: 50, height: 30 },
    ]),
  ).toEqual({ x: -11, y: -5, width: 81, height: 55 });
});
