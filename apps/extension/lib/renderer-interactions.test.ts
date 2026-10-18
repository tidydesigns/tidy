import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Window } from "happy-dom";
import { blankDesignDocument, buildDrawnNode, type DesignNode } from "@tidy/design/document";
import { TidyDesign } from "../../../packages/design-renderer/design";

// This workspace supplies the existing DOM harness for shared renderer integration tests.
let win: Window;
let root: Root | undefined;
const globals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  win = new Window({ url: "https://example.test" });
  for (const key of ["window", "document", "Element", "HTMLElement", "Node", "getComputedStyle"]) {
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
});

afterEach(async () => {
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

function enter(element: Element) {
  element.dispatchEvent(
    new win.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
}

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

test("keyboard focus runs hover once and Enter activates a custom prototype control once", () => {
  const { element, trigger } = renderPrototype();
  (element as unknown as HTMLElement).focus();
  expect(trigger.mock.calls.filter(([, type]) => type === "hover")).toEqual([["action", "hover"]]);
  trigger.mockClear();
  enter(element as unknown as Element);
  expect(trigger.mock.calls.filter(([, type]) => type === "click")).toEqual([["action", "click"]]);
});

test("native buttons leave Enter activation to the browser and disabled controls ignore focus", () => {
  const { element, trigger } = renderPrototype({ element: "button" });
  enter(element as unknown as Element);
  expect(trigger.mock.calls.filter(([, type]) => type === "click")).toHaveLength(0);
  // happy-dom does not synthesize native Enter activation; dispatch its click separately.
  (element as unknown as HTMLButtonElement).click();
  expect(trigger.mock.calls.filter(([, type]) => type === "click")).toEqual([["action", "click"]]);
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
