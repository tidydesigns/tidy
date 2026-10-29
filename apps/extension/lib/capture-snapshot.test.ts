import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { inspectScreenshotPage, waitForCapturePaint } from "./capture-snapshot";

let win: Window;
const originals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  win = new Window();
  for (const key of ["window", "document", "HTMLElement"]) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === "window" ? win : (win as unknown as Record<string, unknown>)[key],
    });
  }
});
afterEach(async () => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});
const readOpenRoot = (element: HTMLElement) => element.shadowRoot;

test("private controls and overflowing or boxless editors disable screenshots before pixels are read", () => {
  for (const markup of [
    '<input type="password" value="secret">',
    '<textarea style="display:none">private</textarea>',
    '<div contenteditable style="display:contents"><p>overflowing private draft</p></div>',
    '<iframe src="about:blank"></iframe>',
  ]) {
    document.body.innerHTML = markup;
    expect(inspectScreenshotPage(readOpenRoot, () => {})).toBe(false);
  }
});

test("closed roots on ordinary divs are unsafe even with zero layout bounds", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const closed = host.attachShadow({ mode: "closed" });
  closed.innerHTML = '<input value="private">';
  expect(host.shadowRoot).toBeNull();
  expect(
    inspectScreenshotPage(
      (element) => (element === host ? closed : element.shadowRoot),
      () => {},
    ),
  ).toBe(false);
});

test("public open roots are observed, nested private content blocks screenshots, and inspection fails closed", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = "<div>Public content</div>";
  const observe = mock(() => {});
  expect(inspectScreenshotPage(readOpenRoot, observe)).toBe(true);
  expect(observe).toHaveBeenCalledWith(shadow);
  shadow.innerHTML = '<input value="private">';
  expect(inspectScreenshotPage(readOpenRoot, observe)).toBe(false);
  expect(inspectScreenshotPage(undefined, observe)).toBe(false);
  expect(
    inspectScreenshotPage(() => {
      throw new Error("unavailable");
    }, observe),
  ).toBe(false);
});

test("snapshot traversal stops before inspecting an unbounded sibling list", () => {
  document.body.innerHTML = "<div></div>".repeat(16000);
  const inspect = mock(readOpenRoot);
  expect(inspectScreenshotPage(inspect, () => {})).toBe(false);
  expect(inspect.mock.calls.length).toBeLessThanOrEqual(15000);
});

test("hidden-tab paint wait times out and cancels its pending animation frame", async () => {
  win.requestAnimationFrame = mock(() => 42);
  win.cancelAnimationFrame = mock(() => {});
  expect(await waitForCapturePaint(5)).toBe(false);
  expect(win.cancelAnimationFrame).toHaveBeenCalledWith(42);
});

test("visible paint waits for two frames and releases its timer", async () => {
  expect(await waitForCapturePaint()).toBe(true);
});
