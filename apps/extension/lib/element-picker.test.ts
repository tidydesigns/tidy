import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { startElementPicker } from "./element-picker";

let win: Window;
let pickerShadow: ShadowRoot;
let picker: ReturnType<typeof startElementPicker> | undefined;
const globals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  win = new Window({ url: "https://example.test", width: 1024, height: 768 });
  for (const key of [
    "window",
    "document",
    "Element",
    "HTMLElement",
    "ShadowRoot",
    "Node",
    "getComputedStyle",
  ]) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === "window"
          ? win
          : key === "getComputedStyle"
            ? win.getComputedStyle.bind(win)
            : (win as unknown as Record<string, unknown>)[key],
    });
  }
  const attachShadow = win.Element.prototype.attachShadow;
  win.Element.prototype.attachShadow = function (options) {
    const shadow = attachShadow.call(this, options);
    pickerShadow = shadow as unknown as ShadowRoot;
    return shadow;
  };
  win.Element.prototype.getBoundingClientRect = () => new win.DOMRect(10, 10, 200, 40);
});

afterEach(async () => {
  picker?.stop();
  picker = undefined;
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  globals.clear();
  await win.happyDOM.close();
});

function key(value: string) {
  (pickerShadow.activeElement ?? win).dispatchEvent(
    new win.KeyboardEvent("keydown", {
      key: value,
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
}

function targetButton() {
  return pickerShadow.querySelector<HTMLButtonElement>("[data-picker-target]")!;
}

test("picker navigates with arrow keys and selects, deselects and copies through button activation", () => {
  win.document.body.innerHTML =
    "<section><h1>Introduction</h1><p>Body copy</p></section><footer>Footer</footer>";
  const onConfirm = mock((_elements: Element[]) => {});
  picker = startElementPicker({ onConfirm, onCancel: () => {} });
  expect(pickerShadow.activeElement).toBe(targetButton());
  expect(targetButton().textContent).toContain("section");
  key("ArrowDown");
  expect(targetButton().textContent).toContain("h1: Introduction");
  // happy-dom does not synthesize native keyboard activation; exercise the click handler directly.
  targetButton().click();
  expect(targetButton().getAttribute("aria-pressed")).toBe("true");
  expect(pickerShadow.querySelector('[role="status"]')?.textContent).toBe("1 element selected.");
  targetButton().click();
  expect(targetButton().getAttribute("aria-pressed")).toBe("false");
  key("ArrowRight");
  expect(targetButton().textContent).toContain("p: Body copy");
  targetButton().click();
  key("ArrowUp");
  key("ArrowRight");
  expect(targetButton().textContent).toContain("footer: Footer");
  targetButton().click();
  key("ArrowLeft");
  expect(targetButton().textContent).toContain("section");
  const copy = [...pickerShadow.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Copy 2 elements"),
  );
  expect(copy).toBeDefined();
  copy!.click();
  expect(onConfirm).toHaveBeenCalledWith([
    win.document.querySelector("p"),
    win.document.querySelector("footer"),
  ]);
  expect(win.document.querySelector("[data-bella-picker]")).toBeNull();
});

test("picker starts at prior focus, restores it on Escape and leaves page activation suppressed", () => {
  win.document.body.innerHTML = '<a href="/next">Continue</a><button>Other</button>';
  const link = win.document.querySelector("a")!;
  link.focus();
  const onCancel = mock(() => {});
  picker = startElementPicker({ onConfirm: () => {}, onCancel });
  expect(targetButton().textContent).toContain("a: Continue");
  expect(
    link.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, composed: true, cancelable: true }),
    ),
  ).toBe(false);
  expect(targetButton().getAttribute("aria-pressed")).toBe("true");
  win.document.documentElement.dispatchEvent(
    new win.PointerEvent("pointermove", { bubbles: true, composed: true }),
  );
  expect(targetButton().textContent).toContain("a: Continue");
  expect(
    win.document.documentElement.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, composed: true, cancelable: true }),
    ),
  ).toBe(false);
  expect(targetButton().textContent).toContain("a: Continue");
  expect(targetButton().getAttribute("aria-pressed")).toBe("true");
  expect(pickerShadow.querySelector('[role="status"]')?.textContent).toBe("1 element selected.");
  key("Escape");
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(win.document.activeElement).toBe(link);
  expect(win.document.querySelector("[data-bella-picker]")).toBeNull();
});

test("picker skips invisible targets and browses open shadow trees", () => {
  win.document.body.innerHTML = '<div style="visibility:hidden">Hidden</div><article></article>';
  const article = win.document.querySelector("article")!;
  article.attachShadow({ mode: "open" }).innerHTML = "<button>Shadow action</button>";
  picker = startElementPicker({ onConfirm: () => {}, onCancel: () => {} });
  expect(targetButton().textContent).toContain("article");
  key("ArrowDown");
  expect(targetButton().textContent).toContain("button: Shadow action");
  key("ArrowUp");
  expect(targetButton().textContent).toContain("article");
});

test("pointer bursts paint the latest target once and scroll reuses selection outlines", () => {
  win.document.body.innerHTML = "<section>First</section><footer>Last</footer>";
  let frame: FrameRequestCallback | undefined;
  const request = mock((callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  win.requestAnimationFrame = request;
  picker = startElementPicker({ onConfirm: () => {}, onCancel: () => {} });
  const first = win.document.querySelector("section")!;
  const last = win.document.querySelector("footer")!;
  for (let i = 0; i < 20; i++) {
    (i % 2 ? first : last).dispatchEvent(
      new win.PointerEvent("pointermove", { bubbles: true, composed: true }),
    );
  }
  expect(request).toHaveBeenCalledTimes(1);
  frame!(0);
  expect(targetButton().textContent).toContain("First");
  targetButton().click();
  const outline = pickerShadow.querySelector(".outline.selected");
  for (let i = 0; i < 20; i++) win.dispatchEvent(new win.Event("scroll"));
  expect(request).toHaveBeenCalledTimes(2);
  frame!(0);
  expect(pickerShadow.querySelector(".outline.selected")).toBe(outline);
});
