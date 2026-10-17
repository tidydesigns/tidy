import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Window } from "happy-dom";
import { blankDesignDocument, buildDrawnNode, type DesignNode } from "@bella/design/document";
import { TidyDesign } from "../../../packages/design-renderer/design";
import { startElementPicker } from "./element-picker";

let win: Window;
let pickerShadow: ShadowRoot;
let picker: ReturnType<typeof startElementPicker> | undefined;
let root: Root | undefined;
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
  root?.unmount();
  root = undefined;
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  globals.clear();
  await win.happyDOM.close();
});

function key(value: string, element?: Element) {
  (element ?? pickerShadow.activeElement ?? win).dispatchEvent(
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

test("picker discovers page elements and selects, deselects and copies entirely from the keyboard", () => {
  win.document.body.innerHTML =
    "<section><h1>Introduction</h1><p>Body copy</p></section><footer>Footer</footer>";
  const onConfirm = mock((_elements: Element[]) => {});
  picker = startElementPicker({ onConfirm, onCancel: () => {} });
  expect(pickerShadow.activeElement).toBe(targetButton());
  expect(targetButton().textContent).toContain("section");
  key("ArrowDown");
  expect(targetButton().textContent).toContain("h1: Introduction");
  targetButton().click(); // Native Space / Enter activation uses the same click path.
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

function renderPrototype(semantics?: DesignNode["semantics"]) {
  const node: DesignNode = {
    ...buildDrawnNode("action", "container", null, { x: 0, y: 0, width: 200, height: 40 }),
    name: "Show details",
    semantics,
    interactions: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        trigger: { type: "hover" },
        action: { type: "back" },
        transition: { type: "instant", duration: 0 },
      },
    ],
  };
  const trigger = mock((_id: string, type: string) => type === "click" || type === "hover");
  const host = win.document.createElement("div");
  win.document.body.append(host);
  root = createRoot(host as unknown as HTMLElement);
  flushSync(() =>
    root!.render(
      createElement(TidyDesign, {
        document: { ...blankDesignDocument(), nodes: [node] },
        rootId: "action",
        frameWidth: 200,
        assets: {},
        onTrigger: trigger,
      }),
    ),
  );
  return { element: host.firstElementChild!, trigger };
}

test("focus runs hover actions and custom prototype controls activate with Enter", () => {
  const { element, trigger } = renderPrototype();
  (element as unknown as HTMLElement).focus();
  expect(trigger).toHaveBeenCalledWith("action", "hover");
  trigger.mockClear();
  key("Enter", element as unknown as Element);
  expect(trigger).toHaveBeenCalledWith("action", "click");
});

test("native buttons keep native activation and disabled hover actions never run", () => {
  const { element, trigger } = renderPrototype({ element: "button" });
  key("Enter", element as unknown as Element);
  expect(trigger.mock.calls.filter(([, type]) => type === "click")).toHaveLength(0);
  (element as unknown as HTMLButtonElement).click();
  expect(trigger.mock.calls.filter(([, type]) => type === "click")).toHaveLength(1);
  root!.unmount();
  root = undefined;
  const disabled = renderPrototype({ element: "button", disabled: true });
  disabled.element.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }));
  expect(disabled.trigger).not.toHaveBeenCalled();
});

test("pointer focus does not repeat a hover prototype action", () => {
  const { element, trigger } = renderPrototype({ element: "button" });
  const matches = element.matches.bind(element);
  element.matches = (selector: string) =>
    selector === ":focus-visible" ? false : matches(selector);
  element.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }));
  expect(trigger).not.toHaveBeenCalled();
});
