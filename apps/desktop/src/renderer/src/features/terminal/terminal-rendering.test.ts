import { expect, test } from "bun:test";
import type { Terminal } from "ghostty-web";
import { installTerminalRendering } from "./terminal-rendering";

test("idle live/history views skip painting; content and presentation changes still paint", () => {
  let paints = 0,
    reads = 0,
    updates = 0;
  let dirty = false;
  let cursor = { x: 0, y: 0, visible: true };
  let selection: { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
  const canvas = { width: 800, height: 600 };
  const native = {
    isDirty() {
      updates++;
      return dirty;
    },
    getCursor: () => cursor,
    getDimensions: () => ({ cols: 2, rows: 2 }),
    isRowDirty: () => dirty,
    needsFullRedraw: () => dirty,
    clearDirty() {
      dirty = false;
    },
    getGraphemeString: () => "",
    getViewport() {
      reads++;
      return [{ codepoint: 65 }, { codepoint: 66 }, { codepoint: 67 }, { codepoint: 68 }];
    },
  };
  type Paint = NonNullable<Terminal["renderer"]>["render"];
  const renderer = {
    render: ((buffer) => {
      paints++;
      // Exercise the once-per-paint viewport adapter with two visible rows.
      expect(buffer.getLine(0)?.map((cell) => cell.codepoint)).toEqual([65, 66]);
      expect(buffer.getLine(1)?.map((cell) => cell.codepoint)).toEqual([67, 68]);
      buffer.clearDirty();
    }) as Paint,
    getCanvas: () => canvas,
    setHoveredHyperlinkId(id: number) {
      void id;
    },
    setHoveredLinkRange(range: unknown) {
      void range;
    },
    setCursorStyle(style: string) {
      void style;
    },
  };
  const terminal = {
    open() {},
    options: { cursorBlink: false },
    renderer,
    wasmTerm: native,
    getSelectionPosition: () => selection,
  } as unknown as Terminal;
  const rendering = installTerminalRendering(terminal);
  terminal.open({} as HTMLElement);
  const paint = (viewportY = 0, opacity = 0, force = false) =>
    renderer.render(terminal.wasmTerm!, force, viewportY, undefined, opacity);
  paint();
  expect(paints).toBe(1);
  for (let frame = 0; frame < 120; frame++) paint();
  expect(paints).toBe(1);
  paint(20);
  for (let frame = 0; frame < 120; frame++) paint(20);
  expect(paints).toBe(2);
  dirty = true;
  paint(20);
  expect(paints).toBe(3);
  cursor = { ...cursor, x: 1 };
  paint(20);
  cursor = { ...cursor, visible: false };
  paint(20);
  expect(paints).toBe(5);
  selection = { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } };
  paint(20);
  selection = undefined;
  paint(20);
  expect(paints).toBe(7);
  renderer.setHoveredHyperlinkId(1);
  paint(20);
  renderer.setHoveredLinkRange(null);
  paint(20);
  renderer.setCursorStyle("bar");
  paint(20);
  expect(paints).toBe(10);
  canvas.width++;
  paint(20);
  paint(20, 0.5);
  paint(20, 0.5, true);
  expect(paints).toBe(13);
  rendering.setActive(false);
  const priorUpdates = updates;
  dirty = true;
  for (let frame = 0; frame < 120; frame++) paint(20);
  expect(updates).toBe(priorUpdates);
  expect(dirty).toBe(true);
  expect(paints).toBe(13);
  rendering.setActive(true);
  paint(20);
  expect(paints).toBe(14);
  expect(reads).toBe(paints);
  terminal.options.cursorBlink = true;
  paint(20);
  paint(20);
  expect(paints).toBe(16);
});
