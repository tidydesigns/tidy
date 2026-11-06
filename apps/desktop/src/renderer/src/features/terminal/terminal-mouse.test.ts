import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Terminal } from "ghostty-web";
import { installTerminalMouse } from "./terminal-mouse";

function mouseFixture() {
  const window = new Window();
  const element = window.document.createElement("div");
  const canvas = window.document.createElement("canvas");
  element.append(canvas);
  window.document.body.append(element);
  canvas.getBoundingClientRect = () => new window.DOMRect(10, 20, 1000, 480);
  const modes = new Set<number>([1002, 1006]);
  const sent: string[] = [];
  let wheel: ((event: WheelEvent) => boolean) | undefined;
  let localSelections = 0;
  const terminal = {
    cols: 100,
    rows: 24,
    viewportY: 0,
    wasmTerm: {
      getMode: (mode: number) => modes.has(mode),
      hasMouseTracking: () => modes.has(1000) || modes.has(1002) || modes.has(1003),
    },
    renderer: { getCanvas: () => canvas },
    input: (data: string) => sent.push(data),
    focus() {},
    clearSelection() {},
    scrollToLine(value: number) {
      this.viewportY = value;
    },
    attachCustomWheelEventHandler(handler?: typeof wheel) {
      wheel = handler;
    },
    open(_element: HTMLElement) {
      void _element;
      canvas.addEventListener("mousedown", () => localSelections++);
    },
    dispose() {},
  };
  installTerminalMouse(terminal as unknown as Terminal);
  terminal.open(element as unknown as HTMLElement);
  return {
    window,
    element,
    canvas,
    modes,
    sent,
    terminal,
    wheel: (event: WheelEvent) => wheel?.(event),
    localSelections: () => localSelections,
  };
}

test("wheel forwarding respects tracking, modifiers, fractional deltas, and local Shift scrolling", () => {
  const f = mouseFixture();
  const wheel = (init: WheelEventInit) =>
    f.wheel({ clientX: 35, clientY: 50, deltaMode: 0, ...init } as WheelEvent);
  expect(wheel({ deltaY: -40 })).toBe(true);
  expect(f.sent).toEqual(["\x1b[<64;3;2M".repeat(2)]);
  f.sent.length = 0;
  wheel({ deltaY: 1, deltaMode: 1, altKey: true, ctrlKey: true });
  expect(f.sent).toEqual(["\x1b[<89;3;2M"]);
  f.sent.length = 0;
  wheel({ deltaY: -5 });
  wheel({ deltaY: -5 });
  wheel({ deltaY: -5 });
  expect(f.sent).toEqual([]);
  wheel({ deltaY: -5 });
  expect(f.sent).toEqual(["\x1b[<64;3;2M"]);
  f.sent.length = 0;
  wheel({ deltaY: -2, deltaMode: 2 });
  expect(f.sent).toEqual(["\x1b[<64;3;2M".repeat(20)]);
  f.sent.length = 0;
  wheel({ deltaY: -40, shiftKey: true });
  expect(f.sent).toEqual([]);
  expect(f.terminal.viewportY).toBe(2);
  f.modes.clear();
  expect(wheel({ deltaY: -40 })).toBe(false);
  f.terminal.dispose();
});

test("tmux clicks and drags precede local selection, clamp outside release and clean up", () => {
  const f = mouseFixture();
  const send = (type: string, init: ConstructorParameters<typeof f.window.MouseEvent>[1] = {}) =>
    f.canvas.dispatchEvent(
      new f.window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 35,
        clientY: 50,
        ...init,
      }),
    );
  send("mousedown");
  send("mousemove", { clientX: 45 });
  send("mousemove", { clientX: 46 }); // Same cell: no redundant motion report.
  send("mouseup", { clientX: 2000, clientY: -10 });
  expect(f.sent).toEqual(["\x1b[<0;3;2M", "\x1b[<32;4;2M", "\x1b[<0;100;1m"]);
  expect(f.localSelections()).toBe(0);
  f.sent.length = 0;
  send("mousedown", { shiftKey: true });
  send("mouseup", { shiftKey: true });
  expect(f.localSelections()).toBe(1);
  expect(f.sent).toEqual([]);
  f.modes.delete(1002);
  f.modes.add(1000);
  send("mousemove");
  expect(f.sent).toEqual([]);
  f.modes.add(1003);
  send("mousemove");
  expect(f.sent).toEqual(["\x1b[<35;3;2M"]);
  f.terminal.dispose();
  f.sent.length = 0;
  send("mousedown");
  send("mouseup");
  expect(f.sent).toEqual([]);
});

test("legacy and UTF-8 mouse encodings never send corrupted raw-byte coordinates", () => {
  const f = mouseFixture();
  f.modes.delete(1006);
  const down = (x: number) =>
    f.canvas.dispatchEvent(
      new f.window.MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: 50 }),
    );
  down(35);
  expect(f.sent).toEqual(['\x1b[M #"']);
  down(1000);
  expect(f.sent).toHaveLength(1); // Non-ASCII raw bytes would be UTF-8 encoded by IPC.
  f.modes.add(1005);
  down(1000);
  expect(f.sent[1]).toBe('\x1b[M \u0084"');
  f.modes.add(1015);
  down(1000);
  expect(f.sent[2]).toBe("\x1b[32;100;2M");
  f.terminal.dispose();
});
