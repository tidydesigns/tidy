import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { subscribePullRequestRefresh } from "./pull-request-refresh";

test("many icons share a foreground clock, coalesce focus events, and stop when unmounted", async () => {
  const browser = new Window();
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: browser, document: browser.document })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const interval = spyOn(globalThis, "setInterval");
  const clear = spyOn(globalThis, "clearInterval");
  let calls = 0;
  let forced = 0;
  const remove = Array.from({ length: 1000 }, () =>
    subscribePullRequestRefresh((force) => {
      calls++;
      if (force) forced++;
    }),
  );
  try {
    expect(interval).toHaveBeenCalledTimes(1);
    browser.dispatchEvent(new browser.Event("focus"));
    browser.document.dispatchEvent(new browser.Event("visibilitychange"));
    await Promise.resolve();
    expect(calls).toBe(1000);
    expect(forced).toBe(1000);
    Object.defineProperty(browser.document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    browser.dispatchEvent(new browser.Event("focus"));
    await Promise.resolve();
    expect(calls).toBe(1000);
    for (const unsubscribe of remove) unsubscribe();
    expect(clear).toHaveBeenCalledTimes(1);
    browser.dispatchEvent(new browser.Event("focus"));
    await Promise.resolve();
    expect(calls).toBe(1000);
  } finally {
    for (const unsubscribe of remove) unsubscribe();
    interval.mockRestore();
    clear.mockRestore();
    await browser.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
