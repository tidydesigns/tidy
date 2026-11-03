import { expect, test } from "bun:test";
import { fileLineTarget } from "./file-line-target";
import type { CodeRow } from "./file-rows";
const rows: CodeRow[] = [1, 2, 3].map((number) => ({
  kind: "lines",
  before: null,
  after: { number, text: `Line ${number}` },
  changed: false,
}));
test("reveals exact lines and bounds stale references to the final available line", () => {
  expect(fileLineTarget(rows, 2)).toEqual({ index: 1, line: 2, exact: true });
  expect(fileLineTarget(rows, 900)).toEqual({ index: 2, line: 3, exact: false });
  expect(fileLineTarget([], 1)).toBeNull();
});
