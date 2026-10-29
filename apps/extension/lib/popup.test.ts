import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { createElement } from "react";

let account = {
  user: { id: "user", name: "User" },
  organizations: [
    { id: "one", name: "One", files: [{ id: "first", name: "First" }] },
    { id: "two", name: "Two", files: [{ id: "second", name: "Second" }] },
  ],
};
let gate: Promise<void> | undefined;
const sendMessage = mock(async () => {
  await gate;
  return { data: account };
});
mock.module("wxt/browser", () => ({
  browser: {
    runtime: { sendMessage },
    storage: {
      local: {
        get: async () => ({
          destination: { userId: "user", organizationId: "one", fileId: "first" },
        }),
      },
      session: { get: async () => ({}) },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  },
}));
function menu(index: number) {
  return document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')[index]!;
}
function choose(index: number, label: string) {
  flushSync(() => menu(index).click());
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
    (button) => button.textContent?.trim() === label,
  )!;
  flushSync(() => option.click());
}
const { App } = await import("../entrypoints/popup/App");
let win: Window;
let root: Root;
const originals = new Map<string, PropertyDescriptor | undefined>();
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
beforeEach(async () => {
  win = new Window();
  for (const key of ["window", "document", "Element", "HTMLElement", "Node", "ResizeObserver"]) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === "window" ? win : (win as unknown as Record<string, unknown>)[key],
    });
  }
  gate = undefined;
  sendMessage.mockClear();
  account = { ...account, user: { id: "user", name: "User" } };
  win.HTMLElement.prototype.showPopover = () => {};
  win.HTMLElement.prototype.hidePopover = () => {};
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(App)));
  await tick();
});
afterEach(async () => {
  root.unmount();
  await tick();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});

test("focus refresh preserves a workspace and file selected while the request is pending", async () => {
  let finish!: () => void;
  gate = new Promise((resolve) => {
    finish = resolve;
  });
  window.dispatchEvent(new win.Event("focus") as unknown as Event);
  choose(0, "Two");
  choose(1, "Second");
  finish();
  await tick();
  expect(menu(0).textContent?.trim()).toBe("Two");
  expect(menu(1).textContent?.trim()).toBe("Second");
});

test("new-file selection stays empty instead of restoring the last saved file", async () => {
  expect(menu(1).textContent?.trim()).toBe("First");
  choose(1, "New design file");
  window.dispatchEvent(new win.Event("focus") as unknown as Event);
  await tick();
  expect(menu(1).textContent?.trim()).toBe("New design file");
});

test("overlapping focus events share one request and account changes discard the prior selection", async () => {
  let finish!: () => void;
  gate = new Promise((resolve) => {
    finish = resolve;
  });
  choose(0, "Two");
  choose(1, "Second");
  for (let i = 0; i < 20; i++) window.dispatchEvent(new win.Event("focus") as unknown as Event);
  expect(sendMessage).toHaveBeenCalledTimes(2); // mount plus one refresh
  account = { ...account, user: { id: "another-user", name: "Another user" } };
  finish();
  await tick();
  expect(menu(0).textContent?.trim()).toBe("One");
  expect(menu(1).textContent?.trim()).toBe("New design file");
});
