import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { SelectMenu } from "@tidy/ui/select-menu";

test("search confirmation ignores IME composition and accepts Enter after composition ends", async () => {
  const window = new Window();
  const globals = new Map<string, PropertyDescriptor | undefined>();
  Object.defineProperty(window.HTMLElement.prototype, "showPopover", { value() {} });
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    Node: window.Node,
    HTMLInputElement: window.HTMLInputElement,
    ResizeObserver: window.ResizeObserver,
    KeyboardEvent: window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const changes: string[] = [];
  try {
    await act(async () =>
      root.render(
        createElement(SelectMenu, {
          label: "Branch",
          value: "main",
          options: [{ value: "feature", label: "feature" }],
          onChange: (value: string) => changes.push(value),
          menuHeader: createElement("input", { "data-select-search": true }),
        }),
      ),
    );
    await act(async () => container.querySelector("button")?.click());
    const search = container.querySelector("input");
    if (!search) throw new Error("The branch search did not open.");
    for (const init of [
      { key: "Enter", isComposing: true },
      { key: "Enter", keyCode: 229 },
    ]) {
      await act(async () => {
        search.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));
      });
      expect(changes).toEqual([]);
      expect(container.querySelector('[role="menu"]')).not.toBeNull();
    }
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(changes).toEqual(["feature"]);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
