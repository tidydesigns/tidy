import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { CommunityAPI } from "../../../../shared/contracts/community";
import CommunityDialog from "./community-dialog";

test("star invitation confirms CLI success, falls back automatically, and safely retries", async () => {
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
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let stars = 0;
  let opens = 0;
  let successes = 0;
  let openFails = false;
  let finish: (value: boolean) => void = () => {};
  const api: CommunityAPI = {
    status: async () => "unavailable",
    star: () => {
      stars++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    open: async () => {
      opens++;
      if (openFails) throw new Error("Browser unavailable");
    },
  };
  const button = () => {
    const element = host.querySelector<HTMLButtonElement>(".community-star-button");
    if (!element) throw new Error("Missing star action");
    return element;
  };
  const render = async () => {
    await act(async () => {
      root.render(null);
    });
    await act(async () => {
      root.render(
        createElement(CommunityDialog, {
          api,
          onDismiss: () => {},
          onSuccess: () => successes++,
        }),
      );
    });
  };
  try {
    await render();
    await act(async () => {
      button().click();
      button().click();
    });
    expect(stars).toBe(1);
    expect(button().disabled).toBe(true);
    await act(async () => finish(true));
    expect(successes).toBe(1);
    expect(opens).toBe(0);
    expect(host.textContent).toContain("Thanks for the star!");

    openFails = true;
    await render();
    await act(async () => button().click());
    await act(async () => finish(false));
    expect(opens).toBe(1);
    expect(host.textContent).toContain("Couldn’t open your browser");
    expect(successes).toBe(1);
    expect(host.querySelector(".community-celebration")).toBeNull();
    expect(button().disabled).toBe(false);
    const attempts = stars;
    openFails = false;
    await act(async () => button().click());
    expect(opens).toBe(2);
    expect(stars).toBe(attempts);
    expect(host.querySelector("dialog")?.open).toBe(false);

    await render();
    await act(async () => button().click());
    await act(async () => host.querySelector("dialog")?.close());
    await act(async () => finish(false));
    expect(opens).toBe(2);
    expect(successes).toBe(1);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
