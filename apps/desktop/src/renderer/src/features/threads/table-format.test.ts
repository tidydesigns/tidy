import { expect, test } from "bun:test";
import { formatTableCsv } from "./table-format";

test("exports CSV with quoted commas, quotes, newlines and empty cells", () => {
  expect(
    formatTableCsv([
      ["Name", "Notes"],
      ["A, B", 'A "quote"\nand line'],
      ["", "終"],
    ]),
  ).toBe('Name,Notes\r\n"A, B","A ""quote""\nand line"\r\n,終');
});
