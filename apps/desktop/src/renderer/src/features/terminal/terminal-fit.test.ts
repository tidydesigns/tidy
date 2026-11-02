import { expect, test } from "bun:test";
import { terminalSizeSchema } from "../../../../shared/contracts/terminal";
import { fitTerminal } from "./terminal-fit";

function fixture() {
  const sizes: { cols: number; rows: number }[] = [];
  const terminal = {
    cols: 80,
    rows: 24,
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      sizes.push({ cols, rows });
    },
  };
  return { terminal, sizes };
}

test("terminal fitting keeps the renderer inside the PTY size contract", () => {
  const f = fixture();
  fitTerminal({ ...f, fit: { proposeDimensions: () => ({ cols: 505, rows: 350 }) } });
  expect(f.sizes).toEqual([{ cols: 500, rows: 300 }]);
  expect(terminalSizeSchema.parse(f.terminal)).toEqual({ cols: 500, rows: 300 });
  fitTerminal({ ...f, fit: { proposeDimensions: () => ({ cols: 1, rows: 0 }) } });
  expect(f.sizes.at(-1)).toEqual({ cols: 2, rows: 1 });
});

test("a snapshot resize is corrected even when the container dimensions have not changed", () => {
  const f = fixture();
  const fit = { proposeDimensions: () => ({ cols: 100, rows: 30 }) };
  fitTerminal({ ...f, fit });
  f.terminal.resize(80, 24);
  fitTerminal({ ...f, fit });
  expect(f.sizes).toEqual([
    { cols: 100, rows: 30 },
    { cols: 80, rows: 24 },
    { cols: 100, rows: 30 },
  ]);
  fitTerminal({ ...f, fit });
  expect(f.sizes).toHaveLength(3);
});

test("a terminal without measurable container dimensions retains its current size", () => {
  const f = fixture();
  fitTerminal({ ...f, fit: { proposeDimensions: () => undefined } });
  expect(f.sizes).toEqual([]);
  expect(f.terminal).toMatchObject({ cols: 80, rows: 24 });
});
