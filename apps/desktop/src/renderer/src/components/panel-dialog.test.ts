import { expect, test } from "bun:test";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { usePanelDialog } from "./panel-dialog";

test("inline panels preserve page focus while modal panels focus their contents", async () => {
  const window = new Window();
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const outside = document.createElement("button");
  const host = document.createElement("div");
  document.body.append(outside, host);
  const root = createRoot(host);
  function Panel({ open, modal }: { open: boolean; modal: boolean }) {
    const ref = useRef<HTMLDialogElement>(null);
    usePanelDialog(ref, open, modal);
    return createElement("dialog", { ref }, createElement("button", null, "Panel control"));
  }
  const render = (open: boolean, modal: boolean) =>
    act(async () => root.render(createElement(Panel, { open, modal })));
  try {
    // Model native dialog focusing, which happy-dom does not implement.
    const prototype = window.HTMLDialogElement.prototype;
    const showModal = prototype.showModal;
    prototype.show = function () {
      this.open = true;
      this.querySelector("button")?.focus();
    };
    prototype.showModal = function () {
      showModal.call(this);
      this.querySelector("button")?.focus();
    };

    await render(true, false);
    expect(document.activeElement === document.body).toBe(true);
    expect(host.querySelector("dialog")?.open).toBe(true);

    outside.focus();
    await render(false, false);
    await render(true, false);
    expect(document.activeElement === outside).toBe(true);

    host.querySelector("button")?.focus();
    await render(false, false);
    expect(document.activeElement === outside).toBe(true);

    await render(true, true);
    expect(document.activeElement === host.querySelector("button")).toBe(true);

    // Responsive modal-to-inline transitions retain focus within the panel.
    await render(true, false);
    expect(document.activeElement === host.querySelector("button")).toBe(true);
    await render(false, false);
    expect(document.activeElement === outside).toBe(true);

    // A close must not override a newer focus choice outside the panel.
    await render(true, false);
    const next = document.createElement("button");
    document.body.append(next);
    next.focus();
    await render(false, false);
    expect(document.activeElement === next).toBe(true);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
