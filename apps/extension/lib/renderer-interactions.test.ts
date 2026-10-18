import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Window } from "happy-dom";
import { blankDesignDocument, buildDrawnNode, type DesignNode } from "@tidy/design/document";
import {
  playInteraction,
  prototypeInteractions,
  startPrototype,
  type PrototypeInteraction,
} from "@tidy/design/prototype";
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

const paintHover: PrototypeInteraction = {
  id: "00000000-0000-4000-8000-000000000001",
  trigger: { type: "hover" },
  action: { type: "setState", target: "action", state: "hover" },
  transition: { type: "instant", duration: 0 },
};
const navigateHover: PrototypeInteraction = {
  ...paintHover,
  id: "00000000-0000-4000-8000-000000000002",
  action: { type: "navigate", target: "second" },
};

function renderPrototype(
  semantics?: DesignNode["semantics"],
  interactions = [paintHover, navigateHover],
) {
  const node: DesignNode = {
    ...buildDrawnNode("action", "container", null, { x: 0, y: 0, width: 200, height: 40 }),
    name: "Show details",
    semantics,
    interactions,
  };
  let session = startPrototype("first");
  const trigger = mock((_id: string, type: "click" | "hover" | "key", key?: string) => {
    const actions = prototypeInteractions(node, type, key);
    session = actions.reduce(playInteraction, session);
    return actions.length > 0;
  });
  root?.unmount();
  const host = win.document.createElement("div");
  win.document.body.replaceChildren(host);
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
  return { element: host.firstElementChild!, trigger, session: () => session };
}

test("focus preserves the prototype context and activation runs hover-only navigation once", () => {
  for (const semantics of [undefined, { element: "button" as const }]) {
    const { element, trigger, session } = renderPrototype(semantics);
    (element as unknown as HTMLElement).focus();
    expect(trigger).not.toHaveBeenCalled();
    expect(session()).toMatchObject({ frameId: "first", history: [], states: {}, entry: 0 });
    // Native keyboard activation produces a click; custom controls handle Enter themselves.
    if (semantics) (element as unknown as HTMLButtonElement).click();
    else enter(element as unknown as Element);
    expect(session()).toMatchObject({
      frameId: "second",
      history: ["first"],
      states: { action: "hover" },
      entry: 1,
    });
    expect(trigger.mock.calls.filter(([, type]) => type === "hover")).toHaveLength(1);
  }
});

test("native buttons leave Enter activation to the browser and disabled controls ignore focus", () => {
  const { element, trigger, session } = renderPrototype({ element: "button" }, [
    navigateHover,
    {
      ...navigateHover,
      id: "00000000-0000-4000-8000-000000000003",
      trigger: { type: "click" },
      action: { type: "navigate", target: "click-destination" },
    },
  ]);
  enter(element as unknown as Element);
  expect(trigger.mock.calls.filter(([, type]) => type === "click")).toHaveLength(0);
  // happy-dom does not synthesize native Enter activation; dispatch its click separately.
  (element as unknown as HTMLButtonElement).click();
  expect(session()).toMatchObject({ frameId: "click-destination", history: ["first"], entry: 1 });
  expect(trigger.mock.calls.filter(([, type]) => type === "click")).toHaveLength(1);
  expect(trigger.mock.calls.filter(([, type]) => type === "hover")).toHaveLength(0);
  const disabled = renderPrototype({ element: "button", disabled: true });
  disabled.element.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }));
  expect(disabled.trigger).not.toHaveBeenCalled();
});

test("paint-only hover feedback runs on keyboard focus without repeating on pointer focus", () => {
  const { element, trigger, session } = renderPrototype({ element: "button" }, [paintHover]);
  const matches = element.matches.bind(element);
  element.matches = (selector: string) =>
    selector === ":focus-visible" ? false : matches(selector);
  element.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }));
  expect(trigger).not.toHaveBeenCalled();
  element.matches = (selector: string) => selector === ":focus-visible" || matches(selector);
  element.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }));
  expect(session()).toMatchObject({ frameId: "first", history: [], states: { action: "hover" } });
  expect(trigger.mock.calls.filter(([, type]) => type === "hover")).toHaveLength(1);
});
