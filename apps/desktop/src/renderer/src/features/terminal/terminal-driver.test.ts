import { expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { Ghostty, Terminal } from "ghostty-web";
import { terminalWasm } from "./terminal-wasm";
import { terminalDriver } from "./terminal-driver";

const load = terminalWasm(
  async () =>
    Uint8Array.from(await readFile(new URL(import.meta.resolve("ghostty-web/ghostty-vt.wasm"))))
      .buffer,
);

async function fixture(
  run: (f: {
    terminal: Terminal;
    driver: ReturnType<typeof terminalDriver>;
    flush(): void;
    pending(): number;
    paints(): number;
    scrollbarPaints(): number;
    glyphs: string[];
    strokes(): number;
    setDocumentHidden(value: boolean): void;
  }) => void,
) {
  const window = new Window();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let paints = 0;
  let scrollbarPaints = 0;
  const glyphs: string[] = [];
  let strokes = 0;
  let now = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const context = new Proxy(
    {
      measureText: () => ({ width: 8, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
      fillText: (text: string) => {
        paints++;
        glyphs.push(text);
      },
      stroke: () => strokes++,
      fillRect() {
        if (String(Reflect.get(context, "fillStyle")).startsWith("rgba(128, 128, 128,"))
          scrollbarPaints++;
      },
    },
    {
      get(target, key) {
        return Reflect.get(target, key) ?? (() => {});
      },
    },
  );
  Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", { value: () => context });
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    Event: window.Event,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  const terminal = new Terminal({
    ghostty: new Ghostty(await load()),
    cols: 40,
    rows: 6,
    cursorBlink: false,
    smoothScrollDuration: 0,
  });
  terminal.focus = () => {};
  const driver = terminalDriver(terminal);
  const element = document.createElement("div");
  document.body.append(element);
  const documentAdds = spyOn(document, "addEventListener");
  const documentRemoves = spyOn(document, "removeEventListener");
  const elementAdds = spyOn(element, "addEventListener");
  const elementRemoves = spyOn(element, "removeEventListener");
  const flush = () => {
    let limit = 30;
    while (frames.size && limit-- > 0) {
      now += 50;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(now));
    }
    expect(frames.size).toBe(0);
  };
  try {
    terminal.open(element);
    flush();
    run({
      terminal,
      driver,
      flush,
      pending: () => frames.size,
      paints: () => paints,
      scrollbarPaints: () => scrollbarPaints,
      glyphs,
      strokes: () => strokes,
      setDocumentHidden(value) {
        Object.defineProperty(document, "hidden", { configurable: true, value });
        document.dispatchEvent(new Event("visibilitychange"));
      },
    });
  } finally {
    terminal.dispose();
    const documentLeaks = documentAdds.mock.calls
      .filter(
        ([name, listener]) =>
          !documentRemoves.mock.calls.some(
            ([event, callback]) => event === name && callback === listener,
          ),
      )
      .map(([name]) => name);
    const elementLeaks = elementAdds.mock.calls
      .filter(
        ([name, listener]) =>
          name === "beforeinput" &&
          !elementRemoves.mock.calls.some(
            ([event, callback]) => event === name && callback === listener,
          ),
      )
      .map(([name]) => name);
    // A scrollbar fade already in progress may finish, but must never paint
    // or revive the disposed scheduler.
    flush();
    clock.mockRestore();
    documentAdds.mockRestore();
    documentRemoves.mockRestore();
    elementAdds.mockRestore();
    elementRemoves.mockRestore();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
    expect(documentLeaks).toEqual([]);
    expect(elementLeaks).toEqual([]);
  }
}

const text = (cells: ReturnType<Terminal["getScrollbackLine"]>) =>
  cells
    ?.map((cell) => String.fromCodePoint(cell.codepoint || 32))
    .join("")
    .trimEnd();
const firstVisible = (terminal: Terminal) =>
  text(terminal.getScrollbackLine(terminal.getScrollbackLength() - terminal.viewportY));
const history = (terminal: Terminal) =>
  terminal.write(Array.from({ length: 30 }, (_, i) => `line ${i}\r\n`).join(""));

test("real Ghostty coalesces bursts and has no idle or hidden render loop", async () => {
  await fixture(({ terminal, driver, flush, pending, paints, setDocumentHidden }) => {
    for (let i = 0; i < 100; i++) terminal.write(`burst ${i}\r\n`);
    expect(pending()).toBe(1);
    flush();
    terminal.scrollToTop();
    flush();
    const painted = paints();
    flush();
    expect(paints()).toBe(painted);
    driver.setActive(false);
    terminal.write("hidden output");
    expect(pending()).toBe(0);
    expect(paints()).toBe(painted);
    driver.setActive(true);
    expect(pending()).toBe(1);
    flush();
    expect(paints()).toBeGreaterThan(painted);
    setDocumentHidden(true);
    terminal.write("background window");
    expect(pending()).toBe(0);
    setDocumentHidden(false);
    expect(pending()).toBe(1);
    flush();
    terminal.write("queued before dispose");
    terminal.dispose();
    expect(pending()).toBe(0);
  });
});

test("resizes preserve a hidden scrollbar and explicit fades still paint", async () => {
  await fixture(({ terminal, flush, scrollbarPaints }) => {
    history(terminal);
    flush();
    terminal.resize(40, 8);
    flush();
    expect(scrollbarPaints()).toBe(0);
    terminal.renderer!.render(terminal.wasmTerm!, true, 0, terminal, 0.4);
    flush();
    const visible = scrollbarPaints();
    expect(visible).toBeGreaterThan(0);
    terminal.resize(40, 6);
    flush();
    expect(scrollbarPaints()).toBeGreaterThan(visible);
    terminal.renderer!.render(terminal.wasmTerm!, false, 0, terminal, 0);
    flush();
    const hidden = scrollbarPaints();
    terminal.resize(40, 8);
    flush();
    expect(scrollbarPaints()).toBe(hidden);
  });
});

test("fractional and changing display scales do not repeatedly resize an unchanged canvas", async () => {
  await fixture(({ terminal, flush, pending }) => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.25 });
    window.dispatchEvent(new Event("resize"));
    expect(pending()).toBe(1);
    flush();
    const canvas = terminal.renderer!.getCanvas();
    const metrics = terminal.renderer!.getMetrics();
    expect(canvas.width).toBe(Math.round(terminal.cols * metrics.width * 1.25));
    expect(canvas.height).toBe(Math.round(terminal.rows * metrics.height * 1.25));
    const resize = spyOn(terminal.renderer!, "resize");
    try {
      terminal.renderer!.render(terminal.wasmTerm!, false, 0, terminal, 0);
      flush();
      expect(resize).not.toHaveBeenCalled();
    } finally {
      resize.mockRestore();
    }
  });
});

test("output, protocol replies and height changes preserve the history being read", async () => {
  await fixture(({ terminal, flush }) => {
    history(terminal);
    flush();
    terminal.scrollToTop();
    flush();
    const first = firstVisible(terminal);
    terminal.write("incoming\r\n\x1b[6n");
    flush();
    expect(terminal.viewportY).toBeGreaterThan(0);
    expect(firstVisible(terminal)).toBe(first);
    terminal.resize(40, 10);
    flush();
    expect(terminal.viewportY).toBeLessThanOrEqual(terminal.getScrollbackLength());
    expect(firstVisible(terminal)).toBe(first);
    terminal.resize(40, 4);
    flush();
    expect(firstVisible(terminal)).toBe(first);
    terminal.input("typed", true);
    expect(terminal.viewportY).toBe(0);
    flush();
    terminal.write("followed output\r\n");
    expect(terminal.viewportY).toBe(0);
    terminal.scrollToTop();
    terminal.write("\x1b[?1049h\x1b[Hfull screen");
    flush();
    expect(terminal.viewportY).toBe(0);
    terminal.write("\x1b[?1049l");
    flush();
    expect(terminal.viewportY).toBe(0);
  });
});

test("selection, link hover, font changes and reset invalidate without an idle loop", async () => {
  await fixture(({ terminal, flush, pending }) => {
    terminal.write("before reset");
    flush();
    terminal.select(0, 0, 6);
    expect(pending()).toBe(1);
    flush();
    expect(terminal.getSelection()).toBe("before");
    terminal.clearSelection();
    expect(pending()).toBe(1);
    flush();
    terminal.renderer!.setHoveredLinkRange({ startX: 0, startY: 0, endX: 5, endY: 0 });
    expect(pending()).toBe(1);
    flush();
    terminal.renderer!.setHoveredLinkRange(null);
    terminal.renderer!.setHoveredHyperlinkId(1);
    expect(pending()).toBe(1);
    flush();
    terminal.options.fontSize = 18;
    expect(pending()).toBe(1);
    flush();
    terminal.reset();
    terminal.write("new memory");
    flush();
    terminal.select(0, 0, 10);
    flush();
    expect(terminal.getSelection()).toBe("new memory");
    terminal.clear();
    expect(pending()).toBe(1);
    flush();
  });
});

test("complex graphemes render from the visible history and live rows", async () => {
  await fixture(({ terminal, flush, glyphs }) => {
    const graphemes = ["a\u0301", "e\u0302", "👩‍💻", "o\u0308", "u\u0304", "n\u0303", "क़", "i\u0301"];
    terminal.write(graphemes.join("\r\n"));
    flush();
    terminal.scrollToLine(1);
    glyphs.length = 0;
    flush();
    // One row of history above five live rows. Screen coordinates differ
    // from both native live-buffer rows and absolute scrollback offsets.
    for (const grapheme of graphemes.slice(1, 7)) expect(glyphs).toContain(grapheme);
  });
});

test("resizing or changing fonts allocates the HiDPI canvas only once", async () => {
  await fixture(({ terminal, flush }) => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    window.dispatchEvent(new Event("resize"));
    flush();
    const resize = spyOn(terminal.renderer!, "resize");
    try {
      terminal.resize(42, 8);
      const canvas = terminal.renderer!.getCanvas();
      expect(canvas.width).toBe(42 * terminal.renderer!.getMetrics().width * 2);
      flush();
      expect(resize).toHaveBeenCalledTimes(1);
      resize.mockClear();
      terminal.options.fontSize = 18;
      flush();
      expect(resize).toHaveBeenCalledTimes(1);
    } finally {
      resize.mockRestore();
    }
  });
});

test("blank cells skip glyph painting but keep backgrounds and text decorations", async () => {
  await fixture(({ terminal, flush, glyphs, strokes }) => {
    glyphs.length = 0;
    terminal.write("hello");
    flush();
    expect(glyphs).toEqual(["h", "e", "l", "l", "o"]);
    const before = strokes();
    terminal.write("\x1b[4m \x1b[0m\x1b[9m \x1b[0m");
    flush();
    expect(strokes() - before).toBe(2);
  });
});

test("repeated identical hover positions do not schedule another paint", async () => {
  await fixture(({ terminal, flush, pending }) => {
    const range = { startX: 0, startY: 0, endX: 5, endY: 0 };
    terminal.renderer!.setHoveredLinkRange(range);
    flush();
    terminal.renderer!.setHoveredLinkRange({ ...range });
    terminal.renderer!.setHoveredHyperlinkId(0);
    expect(pending()).toBe(0);
  });
});

test("reset followed by growth clears all old cells and newly exposed rows", async () => {
  await fixture(({ terminal, flush }) => {
    terminal.resize(98, 16);
    terminal.write(Array.from({ length: 60 }, (_, i) => `line ${i + 1}\r\n`).join(""));
    flush();
    terminal.reset();
    terminal.resize(120, 40);
    terminal.write("prompt $ hello");
    flush();
    expect(
      terminal
        .wasmTerm!.getViewport()
        .slice(14)
        .every((cell) => !cell.codepoint),
    ).toBe(true);
  });
});

test("native reset cancels partial escapes and restores screen, modes, colors and selection", async () => {
  await fixture(({ terminal, flush }) => {
    terminal.write("X");
    const initialCell = { ...terminal.wasmTerm!.getLine(0)![0] };
    const native = terminal.wasmTerm;
    for (const partial of [
      "\x1b[12;",
      "\x1b]0;unfinished",
      "\x1bPunfinished",
      "\x1b",
      new Uint8Array([0xf0, 0x9f]),
    ]) {
      history(terminal);
      terminal.write(
        "\x1b[?2004h\x1b[?1000h\x1b[?1049h\x1b[31;1;4m\x1b[2;4r\x1b[?25l\x1b[3gcontent",
      );
      terminal.select(0, 0, 4);
      terminal.write(partial);
      terminal.reset();
      flush();
      expect(terminal.wasmTerm).toBe(native);
      expect(native!.isAlternateScreen()).toBe(false);
      expect(native!.getScrollbackLength()).toBe(0);
      expect(native!.getMode(2004, false)).toBe(false);
      expect(native!.getMode(1000, false)).toBe(false);
      expect(native!.getCursor()).toMatchObject({ x: 0, y: 0 });
      expect(native!.getCursor().visible).toBeTruthy();
      expect(terminal.hasSelection()).toBe(false);
      terminal.write("X");
      flush();
      expect(native!.getLine(0)![0]).toEqual(initialCell);
      terminal.write("\tY");
      flush();
      expect(native!.getLine(0)![8].codepoint).toBe(89);
    }
  });
});
