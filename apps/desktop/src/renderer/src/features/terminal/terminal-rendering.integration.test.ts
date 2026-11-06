import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { CanvasRenderer, Ghostty, type Terminal } from "ghostty-web";
import { terminalWasm } from "./terminal-wasm";
import { installTerminalRendering } from "./terminal-rendering";

test("real canvas renderer preserves combining characters and emoji across scrollback and fractional scrolling", async () => {
  const window = new Window();
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document: window.document })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const drawn = new Map<string, string>();
  const ctx = {
    measureText: () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    fillText(text: string, x: number, y: number) {
      drawn.set(`${x},${y}`, text);
    },
    fillRect() {},
    scale() {},
    setTransform() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
  };
  window.HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  const load = terminalWasm(
    async () =>
      Uint8Array.from(await readFile(new URL(import.meta.resolve("ghostty-web/ghostty-vt.wasm"))))
        .buffer,
  );
  const native = new Ghostty(await load()).createTerminal(20, 3);
  const canvas = window.document.createElement("canvas");
  const renderer = new CanvasRenderer(canvas as unknown as HTMLCanvasElement);
  const terminal = {
    open() {},
    options: { cursorBlink: false },
    renderer,
    wasmTerm: native,
    getSelectionPosition: () => undefined,
    getScrollbackLength: () => native.getScrollbackLength(),
    getScrollbackLine: (row: number) => native.getScrollbackLine(row),
  } as unknown as Terminal;
  const rendering = installTerminalRendering(terminal);
  terminal.open({} as HTMLElement);
  const paint = (offset: number) => {
    drawn.clear();
    renderer.render(native, true, offset, terminal, 0);
    const { baseline, height } = renderer.getMetrics();
    return [0, 1, 2].map((row) => drawn.get(`0,${row * height + baseline}`));
  };
  try {
    native.write("e\u0301 old\r\n👩‍💻 coder\r\nZ live\r\nQ live");
    expect(native.getScrollbackLength()).toBe(1);
    expect(paint(1)).toEqual(["e\u0301", "👩‍💻", "Z"]);
    // Pixel scrolling can leave a fractional offset; render whole terminal rows.
    expect(paint(0.5)).toEqual(["👩‍💻", "Z", "Q"]);
    expect(paint(1.5)).toEqual(["e\u0301", "👩‍💻", "Z"]);
    rendering.setActive(false);
    native.write("\x1b[?1049h\x1b[Hnvim");
    paint(0);
    rendering.setActive(true);
    expect(paint(0)[0]).toBe("n");
    native.write("\x1b[?1049l");
    expect(paint(0)[0]).toBe("👩‍💻");
  } finally {
    renderer.dispose();
    native.free();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
