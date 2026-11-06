import { expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ITheme } from "ghostty-web";
import type {
  TerminalAPI,
  TerminalInput,
  TerminalOutput,
} from "../../../../shared/contracts/terminal";
import { terminalThemes } from "./terminal-theme";
import { TerminalSurface } from "./terminal-surface";

const records: ReturnType<typeof fakeInstance>[] = [];
let releaseCreate: (() => void) | undefined;
let delayCreate = false;
function fakeInstance(theme: ITheme, size?: { cols: number; rows: number }) {
  let dataListener: ((value: string) => void) | undefined;
  let resizeListener: ((value: { cols: number; rows: number }) => void) | undefined;
  const canvas = document.createElement("canvas");
  const input = document.createElement("textarea");
  const record = {
    theme,
    initialCols: size?.cols ?? 80,
    data: "",
    disposed: false,
    resets: 0,
    terminal: {
      cols: size?.cols ?? 80,
      rows: size?.rows ?? 24,
      viewportY: 0,
      options: { fontSize: 13 },
      element: undefined as HTMLElement | undefined,
      wasmTerm: {},
      renderer: { render() {} },
      open(element: HTMLElement) {
        this.element = element;
        element.append(canvas, input);
        this.focus();
      },
      focus() {
        input.focus();
      },
      resize(cols: number, rows: number) {
        if (cols === this.cols && rows === this.rows) return;
        this.cols = cols;
        this.rows = rows;
        resizeListener?.({ cols, rows });
      },
      write(data: string) {
        record.data += data;
        if (data.includes("\x1b[c")) dataListener?.("\x1b[?1;2c");
      },
      reset() {
        record.resets++;
        record.data = "";
      },
      dispose() {
        record.disposed = true;
        canvas.remove();
        input.remove();
      },
      scrollToLine(offset: number) {
        this.viewportY = offset;
      },
      getSelectionPosition() {
        return undefined;
      },
      attachCustomKeyEventHandler() {},
      onTitleChange() {
        return { dispose() {} };
      },
      onData(callback: typeof dataListener) {
        dataListener = callback;
        return {
          dispose() {
            dataListener = undefined;
          },
        };
      },
      onResize(callback: typeof resizeListener) {
        resizeListener = callback;
        return {
          dispose() {
            resizeListener = undefined;
          },
        };
      },
      emitData(value: string) {
        dataListener?.(value);
      },
    },
    fit: { fit() {} },
    setActive() {},
  };
  return record;
}
mock.module("./terminal-runtime", () => ({
  createTerminal: async (theme: ITheme, size?: { cols: number; rows: number }) => {
    if (delayCreate)
      await new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
    const record = fakeInstance(theme, size);
    records.push(record);
    return record;
  },
}));

test("theme changes keep the stream attached, defer hidden tabs, and cancel stale replacements", async () => {
  const window = new Window();
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    ResizeObserver: window.ResizeObserver,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  records.length = 0;
  let watchCount = 0,
    closeCount = 0,
    endCount = 0;
  let receive: (output: TerminalOutput) => void = () => {};
  const writes: TerminalInput[] = [];
  const copied: string[] = [];
  let blockCopy = false;
  let failCopy = false;
  let releaseCopy: (() => void) | undefined;
  const copy = async (text: string) => {
    copied.push(text);
    if (failCopy) throw new Error("Clipboard unavailable");
    if (blockCopy)
      await new Promise<void>((resolve) => {
        releaseCopy = resolve;
      });
  };
  const api: TerminalAPI = {
    async end() {
      endCount++;
    },
    watch(_scope, callback) {
      watchCount++;
      receive = callback;
      queueMicrotask(() =>
        callback({
          kind: "snapshot",
          sessionId: "session",
          sequence: 1,
          cols: 120,
          rows: 30,
          data: "initial\x1b[c",
          reset: true,
          exited: false,
          exitCode: null,
        }),
      );
      return {
        input(value) {
          if (value.kind === "write") writes.push(value);
        },
        close() {
          closeCount++;
        },
      };
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (theme: ITheme, active = true, fontSize = 13) =>
    act(async () => {
      root.render(
        createElement(TerminalSurface, {
          api,
          projectId: "project",
          terminalId: "terminal",
          active,
          focusOnActivate: true,
          fontSize,
          theme,
          onTitle() {},
          copy,
        }),
      );
      for (let index = 0; index < 8; index++)
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
  try {
    await render(terminalThemes.light);
    expect(records).toHaveLength(1);
    expect(records[0].data).toBe("initial\x1b[c");
    expect(records[0].resets).toBe(0);
    expect(writes).toEqual([]); // History queries must not become shell input.
    await render(terminalThemes.dark);
    expect(records).toHaveLength(2);
    expect(records[0].disposed).toBe(true);
    expect(records[1].data).toBe("initial\x1b[c");
    expect(records[1].initialCols).toBe(120);
    expect(watchCount).toBe(1);
    expect(closeCount).toBe(0);
    expect(writes).toEqual([]); // A theme replay must not resend terminal replies.
    records[1].terminal.emitData("typed");
    expect(writes).toEqual([{ kind: "write", sessionId: "session", data: "typed" }]);
    await render(terminalThemes.light, false);
    expect(records).toHaveLength(2);
    await act(async () =>
      receive({ kind: "data", sessionId: "session", sequence: 2, data: "later" }),
    );
    await render(terminalThemes.light);
    expect(records).toHaveLength(3);
    expect(records[2].data).toBe("initial\x1b[clater");
    delayCreate = true;
    await render(terminalThemes.dark);
    await act(async () =>
      receive({ kind: "data", sessionId: "session", sequence: 3, data: "incoming" }),
    );
    await render(terminalThemes.dark, true, 18);
    delayCreate = false;
    await act(async () => {
      releaseCreate?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(records[3].data).toBe("initial\x1b[claterincoming");
    expect(records[3].terminal.options.fontSize).toBe(18);
    delayCreate = true;
    await render(terminalThemes.light, true, 18);
    await render(terminalThemes.dark, true, 18);
    delayCreate = false;
    await act(async () => {
      releaseCreate?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(records.at(-1)?.disposed).toBe(true);
    expect(records[3].disposed).toBe(false);
    expect(watchCount).toBe(1);
    expect(endCount).toBe(0);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    await act(async () =>
      receive({
        kind: "snapshot",
        sessionId: "session",
        sequence: 8,
        cols: 120,
        rows: 30,
        data: "recovered",
        reset: true,
        exited: false,
        exitCode: null,
      }),
    );
    expect(records[3].data).toBe("recovered");
    expect(records[3].resets).toBe(1);
    await act(async () =>
      receive({ kind: "data", sessionId: "session", sequence: 9, data: "x".repeat(600_000) }),
    );
    await render(terminalThemes.light, true, 18);
    expect(watchCount).toBe(2);
    expect(closeCount).toBe(1);
    expect(endCount).toBe(0);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    await act(async () =>
      receive({ kind: "data", sessionId: "session", sequence: 2, data: "\x1b[c" }),
    );
    expect(writes.at(-1)).toEqual({ kind: "write", sessionId: "session", data: "\x1b[?1;2c" });
    expect(
      writes.filter((entry) => entry.kind === "write" && entry.data === "\x1b[?1;2c"),
    ).toHaveLength(1);
    const osc = "\x1b]52;c;aGk=\x07";
    await act(async () => receive({ kind: "data", sessionId: "session", sequence: 3, data: osc }));
    expect(copied).toEqual(["hi"]);
    await render(terminalThemes.dark, true, 18);
    expect(copied).toEqual(["hi"]); // Theme replay must not overwrite the desktop clipboard.
    await act(async () =>
      receive({
        kind: "snapshot",
        sessionId: "session",
        sequence: 4,
        cols: 120,
        rows: 30,
        data: osc + osc.slice(0, 4),
        reset: true,
        exited: false,
        exitCode: null,
      }),
    );
    await act(async () =>
      receive({ kind: "data", sessionId: "session", sequence: 5, data: osc.slice(4) }),
    );
    expect(copied).toEqual(["hi"]); // Even a partial query beginning in replay stays suppressed.
    await act(async () => receive({ kind: "data", sessionId: "session", sequence: 6, data: osc }));
    expect(copied).toEqual(["hi", "hi"]);
    blockCopy = true;
    await act(async () => receive({ kind: "data", sessionId: "session", sequence: 7, data: osc }));
    await act(async () =>
      receive({
        kind: "data",
        sessionId: "session",
        sequence: 8,
        data: "\x1b]52;c;b2xk\x07\x1b]52;c;bmV3\x07",
      }),
    );
    expect(copied).toEqual(["hi", "hi", "hi"]);
    blockCopy = false;
    await act(async () => {
      releaseCopy?.();
    });
    expect(copied).toEqual(["hi", "hi", "hi", "new"]); // Serialize writes and coalesce pending text.
    failCopy = true;
    await act(async () => receive({ kind: "data", sessionId: "session", sequence: 9, data: osc }));
    expect(container.textContent).toContain("Could not copy terminal text.");
  } finally {
    delayCreate = false;
    releaseCreate?.();
    await act(async () => root.unmount());
    expect(closeCount).toBe(2);
    expect(records.every((record) => record.disposed)).toBe(true);
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
